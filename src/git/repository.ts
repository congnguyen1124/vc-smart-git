import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { parseBlamePorcelain } from './blame';
import { parseBranches, parseLog, parsePorcelainV2 } from './parsers';
import type { GitBlameLine } from './blame';
import type {
  GitAuthor,
  GitBranch,
  GitCommit,
  GitCommitFile,
  GitConflict,
  GitConflictSideStatus,
  GitConflictState,
  GitOperation,
  GitStatus,
  GitTag,
} from './types';

const LOG_FORMAT = '--pretty=format:%H%x00%h%x00%P%x00%aN%x00%aE%x00%aI%x00%D%x00%s%x00%b%x1e';
const HISTORY_REFS = ['--exclude=refs/stash', '--all'];

interface LogOptions {
  ref?: string;
  author?: GitAuthor;
}

interface RunOptions {
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandError extends Error {
  public constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(stderr.trim() || `Git exited with code ${exitCode}`);
    this.name = 'GitCommandError';
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function parseNameStatus(output: string): GitCommitFile[] {
  const fields = output.split('\0').filter(Boolean);
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      const originalPath = fields[index++];
      const filePath = fields[index++];
      if (originalPath && filePath) {
        files.push({ status: status[0] ?? status, path: filePath, originalPath });
      }
    } else {
      const filePath = fields[index++];
      if (filePath) {
        files.push({ status: status[0] ?? status, path: filePath });
      }
    }
  }
  return files;
}

interface UnmergedStages {
  ours?: string;
  theirs?: string;
}

function conflictSideStatuses(code: string): [GitConflictSideStatus, GitConflictSideStatus] {
  switch (code) {
    case 'DD': return ['Deleted', 'Deleted'];
    case 'AU': return ['Added', 'Deleted'];
    case 'UD': return ['Modified', 'Deleted'];
    case 'UA': return ['Deleted', 'Added'];
    case 'DU': return ['Deleted', 'Modified'];
    case 'AA': return ['Added', 'Added'];
    default: return ['Modified', 'Modified'];
  }
}

function parseUnmergedStages(output: string): Map<string, UnmergedStages> {
  const result = new Map<string, UnmergedStages>();
  for (const record of output.split('\0')) {
    if (!record) {
      continue;
    }
    const separator = record.indexOf('\t');
    if (separator < 0) {
      continue;
    }
    const metadata = record.slice(0, separator).trim().split(/\s+/);
    const filePath = record.slice(separator + 1);
    const hash = metadata[1];
    const stage = metadata[2];
    if (!filePath || !hash || (stage !== '2' && stage !== '3')) {
      continue;
    }
    const stages = result.get(filePath) ?? {};
    if (stage === '2') {
      stages.ours = hash;
    } else {
      stages.theirs = hash;
    }
    result.set(filePath, stages);
  }
  return result;
}

export class GitRepository {
  public constructor(
    public readonly root: string,
    private readonly gitPath = 'git',
  ) {}

  public run(args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.gitPath,
        ['-C', this.root, ...args],
        {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            ...options.env,
          },
        },
        (error, stdout, stderr) => {
          const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
          const result = { stdout, stderr, exitCode };
          if (error && !options.allowFailure) {
            reject(new GitCommandError(args, exitCode, stderr));
          } else {
            resolve(result);
          }
        },
      );
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }

  public async status(): Promise<GitStatus> {
    const result = await this.run([
      'status',
      '--porcelain=v2',
      '--branch',
      '--ahead-behind',
      '--untracked-files=all',
      '-z',
    ]);
    return parsePorcelainV2(result.stdout);
  }

  public async blame(filePath: string, contents?: string): Promise<GitBlameLine[]> {
    const args = ['blame', '--line-porcelain'];
    if (contents !== undefined) {
      args.push('--contents', '-');
    }
    args.push('--', filePath);
    const result = await this.run(args, { ...(contents !== undefined ? { input: contents } : {}) });
    return parseBlamePorcelain(result.stdout);
  }

  public async log(limit: number, { ref, author }: LogOptions = {}): Promise<GitCommit[]> {
    const authorOptions: string[] = [];
    if (author) {
      const identity = `${author.name} <${author.email}>`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      authorOptions.push('--extended-regexp', '--use-mailmap', `--author=^${identity}$`);
    }
    const result = await this.run([
      'log',
      `--max-count=${limit}`,
      '--topo-order',
      '--date=iso-strict',
      '--decorate=short',
      '--decorate-refs-exclude=refs/stash',
      LOG_FORMAT,
      ...authorOptions,
      ...(ref ? ['--end-of-options', ref] : HISTORY_REFS),
      '--',
    ]);
    return parseLog(result.stdout);
  }

  public async logAuthors(): Promise<GitAuthor[]> {
    const result = await this.run(['shortlog', '-se', ...HISTORY_REFS, '--'], { input: '' });
    return result.stdout.split('\n').flatMap((line) => {
      const match = /^\s*\d+\t(.*) <([^<>]*)>$/.exec(line);
      return match ? [{ name: match[1] ?? '', email: match[2] ?? '' }] : [];
    });
  }

  public async commitByHash(hash: string): Promise<GitCommit | undefined> {
    const result = await this.run([
      'show',
      '--no-patch',
      '--date=iso-strict',
      '--decorate=short',
      LOG_FORMAT,
      hash,
    ], { allowFailure: true });
    return result.exitCode === 0 ? parseLog(result.stdout)[0] : undefined;
  }

  public async remoteUrl(name = 'origin'): Promise<string | undefined> {
    const result = await this.run(['remote', 'get-url', name], { allowFailure: true });
    const value = result.stdout.trim();
    return result.exitCode === 0 && value ? value : undefined;
  }

  public async branches(): Promise<GitBranch[]> {
    const result = await this.run([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:trackshort)%00%(upstream:track)%00%(objectname)%00%(committerdate:iso-strict)%00%(worktreepath)%00%(symref)',
      'refs/heads',
      'refs/remotes',
    ]);
    return parseBranches(result.stdout);
  }

  public async tags(): Promise<GitTag[]> {
    const result = await this.run(['for-each-ref', '--format=%(refname)', 'refs/tags']);
    return result.stdout.split('\n').filter(Boolean).map((ref) => ({ ref, name: ref.slice('refs/tags/'.length) }));
  }

  public async commitDetails(hash: string): Promise<string> {
    const result = await this.run([
      'show',
      '--no-ext-diff',
      '--stat',
      '--summary',
      '--format=fuller',
      '--date=iso-strict',
      hash,
    ]);
    return result.stdout.trim();
  }

  public async commitFiles(hash: string): Promise<GitCommitFile[]> {
    const result = await this.run([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-z',
      hash,
    ]);
    return parseNameStatus(result.stdout);
  }

  public async filesAgainst(hash: string): Promise<GitCommitFile[]> {
    const result = await this.run(['diff', '--name-status', '-z', hash, '--']);
    return parseNameStatus(result.stdout);
  }

  public async diff(filePath: string, staged: boolean, conflicted: boolean): Promise<string> {
    const args = ['diff', '--no-color', '--no-ext-diff', '--unified=6'];
    if (staged) {
      args.push('--cached');
    } else if (conflicted) {
      args.push('--cc');
    }
    args.push('--', filePath);
    const result = await this.run(args, { allowFailure: true });
    return result.stdout;
  }

  public async readCommitBlob(revision: string, filePath: string): Promise<string> {
    const result = await this.run(['show', `${revision}:${filePath}`], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout : '';
  }

  public async readBlob(revision: 'HEAD' | ':', filePath: string): Promise<string> {
    const spec = revision === ':' ? `:${filePath}` : `HEAD:${filePath}`;
    const result = await this.run(['show', spec], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout : '';
  }

  public async stage(paths: readonly string[]): Promise<void> {
    if (paths.length > 0) {
      await this.run(['add', '--', ...paths]);
    }
  }

  public async stageAll(): Promise<void> {
    
    await this.run(['add', '-A']);
  }

  public async unstage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    const restore = await this.run(['restore', '--staged', '--', ...paths], { allowFailure: true });
    if (restore.exitCode !== 0) {
      await this.run(['reset', '--', ...paths]);
    }
  }

  public async unstageAll(): Promise<void> {
    await this.run(['reset']);
  }

  public async rollbackTracked(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);
  }

  public async commit(message: string, amend: boolean): Promise<void> {
    const args = ['commit'];
    if (amend) {
      args.push('--amend');
    }
    args.push('-m', message);
    await this.run(args);
  }

  public async fetch(): Promise<void> {
    await this.run(['fetch', '--all', '--prune']);
  }

  public async pull(): Promise<void> {
    await this.run(['pull', '--ff-only']);
  }

  public async push(): Promise<void> {
    await this.run(['push']);
  }

  public async publish(branch: string, remote = 'origin'): Promise<void> {
    await this.run(['push', '--set-upstream', remote, branch]);
  }

  public async switchBranch(branch: string): Promise<void> {
    await this.run(['switch', branch]);
  }

  public async switchDetached(hash: string): Promise<void> {
    await this.run(['switch', '--detach', hash]);
  }

  public async createBranch(name: string, startPoint?: string): Promise<void> {
    await this.run(['switch', '-c', name, ...(startPoint ? [startPoint] : [])]);
  }

  public async createTag(name: string, hash: string): Promise<void> {
    await this.run(['tag', name, hash]);
  }

  public async deleteBranch(name: string): Promise<void> {
    await this.run(['branch', '-d', name]);
  }

  public async cherryPick(hash: string): Promise<void> {
    await this.run(['cherry-pick', hash]);
  }

  public async revert(hash: string): Promise<void> {
    await this.run(['revert', '--no-edit', hash]);
  }

  public async resetHard(hash: string): Promise<void> {
    await this.run(['reset', '--hard', hash]);
  }

  public async useConflictSide(filePath: string, side: 'ours' | 'theirs', deleted = false): Promise<void> {
    if (deleted) {
      await this.run(['rm', '--ignore-unmatch', '--', filePath]);
      return;
    }
    await this.run(['checkout', `--${side}`, '--', filePath]);
    await this.stage([filePath]);
  }

  public async conflicts(status: GitStatus, operation?: GitOperation): Promise<GitConflictState> {
    const unmerged = await this.run(['ls-files', '--unmerged', '-z'], { allowFailure: true });
    const stages = parseUnmergedStages(unmerged.stdout);
    const files: GitConflict[] = status.changes
      .filter((change) => change.conflicted)
      .map((change) => {
        const code = `${change.indexStatus}${change.worktreeStatus}`;
        const [ours, theirs] = conflictSideStatuses(code);
        const fileStages = stages.get(change.path) ?? {};
        const bothDeleted = code === 'DD';
        const identical = Boolean(fileStages.ours && fileStages.theirs && fileStages.ours === fileStages.theirs);
        return {
          path: change.path,
          status: code,
          ours,
          theirs,
          oursAvailable: Boolean(fileStages.ours),
          theirsAvailable: Boolean(fileStages.theirs),
          simple: bothDeleted || identical,
          ...(bothDeleted ? { simpleReason: 'bothDeleted' as const } : identical ? { simpleReason: 'identical' as const } : {}),
        };
      });
    const incomingLabel = operation ? await this.operationTarget(operation) : undefined;
    return {
      currentBranch: status.branch,
      ...(incomingLabel ? { incomingLabel } : {}),
      ...(operation ? { operation } : {}),
      files,
    };
  }

  public async resolveSimpleConflicts(conflicts: readonly GitConflict[]): Promise<void> {
    for (const conflict of conflicts) {
      if (!conflict.simple || !conflict.simpleReason) {
        continue;
      }
      if (conflict.simpleReason === 'bothDeleted') {
        await this.run(['rm', '--ignore-unmatch', '--', conflict.path]);
      } else {
        await this.run(['checkout', '--ours', '--', conflict.path]);
        await this.stage([conflict.path]);
      }
    }
  }

  private async operationTarget(operation: GitOperation): Promise<string | undefined> {
    const marker = operation === 'merge'
      ? 'MERGE_HEAD'
      : operation === 'cherry-pick'
        ? 'CHERRY_PICK_HEAD'
        : operation === 'revert'
          ? 'REVERT_HEAD'
          : operation === 'rebase'
            ? 'REBASE_HEAD'
            : undefined;
    if (!marker) {
      return undefined;
    }
    const revision = await this.run(['rev-parse', marker], { allowFailure: true });
    const hash = revision.stdout.trim();
    if (revision.exitCode !== 0 || !hash) {
      return undefined;
    }
    const refs = await this.run([
      'for-each-ref',
      `--points-at=${hash}`,
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes',
    ], { allowFailure: true });
    return refs.stdout.split('\n').map((value) => value.trim()).find(Boolean) ?? hash.slice(0, 8);
  }

  public async operation(): Promise<GitOperation | undefined> {
    const gitDirResult = await this.run(['rev-parse', '--absolute-git-dir']);
    const gitDir = gitDirResult.stdout.trim();
    const checks: Array<[GitOperation, string[]]> = [
      ['merge', ['MERGE_HEAD']],
      ['rebase', ['rebase-merge', 'rebase-apply']],
      ['cherry-pick', ['CHERRY_PICK_HEAD']],
      ['revert', ['REVERT_HEAD']],
      ['bisect', ['BISECT_LOG']],
    ];
    for (const [operation, markers] of checks) {
      for (const marker of markers) {
        if (await exists(path.join(gitDir, marker))) {
          return operation;
        }
      }
    }
    return undefined;
  }

  public async continueOperation(operation: GitOperation): Promise<void> {
    const env = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
    switch (operation) {
      case 'merge':
        await this.run(['commit', '--no-edit'], { env });
        return;
      case 'rebase':
        await this.run(['rebase', '--continue'], { env });
        return;
      case 'cherry-pick':
        await this.run(['cherry-pick', '--continue'], { env });
        return;
      case 'revert':
        await this.run(['revert', '--continue'], { env });
        return;
      case 'bisect':
        throw new Error('Bisect does not have a generic continue action. Mark the current commit good or bad.');
    }
  }

  public async abortOperation(operation: GitOperation): Promise<void> {
    switch (operation) {
      case 'merge': await this.run(['merge', '--abort']); return;
      case 'rebase': await this.run(['rebase', '--abort']); return;
      case 'cherry-pick': await this.run(['cherry-pick', '--abort']); return;
      case 'revert': await this.run(['revert', '--abort']); return;
      case 'bisect': await this.run(['bisect', 'reset']); return;
    }
  }
}
