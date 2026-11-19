import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitRepository } from './repository';

const MAX_TEXT_BYTES = 750_000;
type ConflictBases = Array<[key: string, base: string]>;
const { scanConflicts, recoverConflictBases } = require('../../media/mergeModel.js') as {
  scanConflicts(text: string, markerSize: number): { blocks: Array<{ base?: string }>; malformed: boolean };
  recoverConflictBases(working: string, reproduced: string, markerSize: number): ConflictBases;
};

type MergeStage = { mode: string; oid: string };
type MergeSide = 'ours' | 'theirs';

export interface MergeVersion {
  present: boolean;
  text?: string;
  note?: string;
}

interface WorkingFile {
  fingerprint: string;
  mode?: number;
  text?: string;
  bom?: boolean;
  eol?: '\r\n' | '\n';
  note?: string;
}

export interface MergeSnapshot {
  filePath: string;
  index: string;
  markerSize: number;
  working: WorkingFile;
  base: MergeVersion;
  ours: MergeVersion;
  theirs: MergeVersion;
  conflictBases: ConflictBases;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function workingPath(root: string, filePath: string): Promise<string> {
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, filePath);
  const relative = path.relative(realRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The conflicted file is outside the repository.');
  }
  const parent = path.dirname(absolute);
  try {
    if (await realpath(parent) !== parent) {
      throw new Error('The conflicted file is inside a symbolic link.');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return absolute;
}

async function readWorkingFile(absolute: string): Promise<WorkingFile> {
  try {
    const info = await lstat(absolute);
    const metadata = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) {
      return { fingerprint: metadata, note: 'This file cannot be edited as text. You can still accept an entire side.' };
    }
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) {
        throw new Error('The working file changed. Reload the conflict.');
      }
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error('The working file changed. Reload the conflict.');
      const content = bytes.subarray(0, bytesRead);
      const fingerprint = `${stat.mode}:${createHash('sha256').update(content).digest('hex')}`;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        return { fingerprint, note: 'The working file is not UTF-8. Accept an entire side to resolve it.' };
      }
      const lf = text.replace(/\r\n/g, '\n');
      const hasCrLf = lf !== text;
      if (lf.includes('\0') || lf.includes('\r') || (hasCrLf && /(^|[^\r])\n/.test(text))) {
        return { fingerprint, note: 'The working file is binary or uses mixed line endings. Accept an entire side to resolve it.' };
      }
      return {
        fingerprint, mode: stat.mode, text: lf, eol: hasCrLf ? '\r\n' : '\n',
        bom: content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isMissing(error)) return { fingerprint: 'missing', note: 'This file is absent from the working tree. Choose which side to keep.' };
    throw error;
  }
}

async function unmergedIndex(repo: GitRepository, filePath: string): Promise<string> {
  return (await repo.run(['--literal-pathspecs', 'ls-files', '--unmerged', '-z', '--', filePath])).stdout;
}

function readStages(index: string, filePath: string): Map<number, MergeStage> {
  const stages = new Map<number, MergeStage>();
  for (const record of index.split('\0')) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t/.exec(record);
    if (match && record.slice(match[0].length) === filePath && match[1] && match[2]) {
      stages.set(Number(match[3]), { mode: match[1], oid: match[2] });
    }
  }
  return stages;
}

async function readVersion(repo: GitRepository, stage?: MergeStage): Promise<MergeVersion> {
  if (!stage) return { present: false };
  if (!/^100(?:644|755)$/.test(stage.mode)) return { present: true, note: 'This revision is not a regular file.' };
  const { stdout: size } = await repo.run(['cat-file', '-s', stage.oid]);
  if (Number(size) > MAX_TEXT_BYTES) return { present: true, note: 'This revision is too large to preview.' };
  const { stdout: text } = await repo.run(['cat-file', 'blob', stage.oid]);
  return /[\0\ufffd]/.test(text)
    ? { present: true, note: 'Binary or non-UTF-8 revision.' }
    : { present: true, text: text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n') };
}

async function recoverWorkingBases(
  repo: GitRepository,
  working: string,
  markerSize: number,
  ours: MergeVersion,
  base: MergeVersion,
  theirs: MergeVersion,
): Promise<ConflictBases> {
  if (ours.text === undefined || base.text === undefined || theirs.text === undefined) return [];
  const scan = scanConflicts(working, markerSize);
  if (scan.malformed || !scan.blocks.some((block) => block.base === undefined)) return [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vc-smart-git-diff3-'));
  try {
    const files = ['current', 'base', 'incoming'].map((name) => path.join(directory, name));
    await Promise.all([ours.text, base.text, theirs.text].map((text, index) => writeFile(files[index]!, text)));
    for (const style of ['--zdiff3', '--diff3']) {
      const { stdout } = await repo.run(
        ['merge-file', '--stdout', style, `--marker-size=${markerSize}`, ...files], { allowFailure: true },
      );
      // Use Git's ancestor chunks only when they reproduce the same markers
      // and surrounding content as the user's working copy.
      const recovered = recoverConflictBases(working, stdout, markerSize);
      if (recovered.length) return recovered;
    }
    return [];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function loadMergeSnapshot(repo: GitRepository, filePath: string): Promise<MergeSnapshot> {
  const absolute = await workingPath(repo.root, filePath);
  const index = await unmergedIndex(repo, filePath);
  const stages = readStages(index, filePath);
  if (!stages.size) throw new Error('This file no longer has an unresolved conflict.');
  const [working, attribute, base, ours, theirs] = await Promise.all([
    readWorkingFile(absolute),
    repo.run(['check-attr', '-z', 'conflict-marker-size', '--', filePath]),
    readVersion(repo, stages.get(1)),
    readVersion(repo, stages.get(2)),
    readVersion(repo, stages.get(3)),
  ]);
  const size = Number(attribute.stdout.split('\0')[2]);
  const markerSize = Number.isInteger(size) && size > 0 && size <= 1_000 ? size : 7;
  if ([2, 3].some((stage) => stages.get(stage) && !/^100(?:644|755)$/.test(stages.get(stage)!.mode))) {
    delete working.text;
    working.note = 'This conflict involves a file type change. Accept an entire side to keep its Git file type.';
  }
  const conflictBases = working.text === undefined ? []
    : await recoverWorkingBases(repo, working.text, markerSize, ours, base, theirs).catch(() => []);
  return { filePath, index, markerSize, working, base, ours, theirs, conflictBases };
}

async function verifySnapshot(repo: GitRepository, snapshot: MergeSnapshot): Promise<string> {
  const absolute = await workingPath(repo.root, snapshot.filePath);
  const [index, working] = await Promise.all([unmergedIndex(repo, snapshot.filePath), readWorkingFile(absolute)]);
  if (index !== snapshot.index || working.fingerprint !== snapshot.working.fingerprint) {
    throw new Error('The conflict changed on disk or in the index. Close and reopen this editor to reload the file.');
  }
  return absolute;
}

export class MergeStageError extends Error {}

export async function applyMergeResult(repo: GitRepository, snapshot: MergeSnapshot, text: string): Promise<void> {
  const { working, markerSize, filePath } = snapshot;
  if (working.text === undefined || working.mode === undefined || text.includes('\0') || text.includes('\r')) {
    throw new Error('The result must be editable UTF-8 text.');
  }
  const scan = scanConflicts(text, markerSize);
  if (scan.blocks.length || scan.malformed) throw new Error('Resolve the remaining conflict markers before applying.');
  const content = (working.bom ? '\ufeff' : '') + (working.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error('The merge result is too large.');
  const absolute = await verifySnapshot(repo, snapshot);
  if (text !== working.text) {
    const temporary = path.join(path.dirname(absolute), `.vc-smart-git-${randomUUID()}`);
    await writeFile(temporary, content, { flag: 'wx', mode: working.mode & 0o777 });
    try {
      await chmod(temporary, working.mode & 0o777);
      await verifySnapshot(repo, snapshot);
      await rename(temporary, absolute);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  try {
    await repo.run(['--literal-pathspecs', 'add', '--', filePath]);
  } catch (error) {
    throw new MergeStageError(`The result is on disk, but Git could not stage it. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function acceptMergeSide(repo: GitRepository, snapshot: MergeSnapshot, side: MergeSide): Promise<void> {
  await verifySnapshot(repo, snapshot);
  const filePath = snapshot.filePath;
  if (!snapshot[side].present) {
    await repo.run(['--literal-pathspecs', 'rm', '--', filePath]);
    return;
  }
  await repo.run(['--literal-pathspecs', 'checkout', `--${side}`, '--', filePath]);
  try {
    await repo.run(['--literal-pathspecs', 'add', '--', filePath]);
  } catch (error) {
    throw new MergeStageError(`Git checked out the chosen side but could not stage it. ${error instanceof Error ? error.message : String(error)}`);
  }
}
