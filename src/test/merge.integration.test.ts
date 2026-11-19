import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptMergeSide, applyMergeResult, loadMergeSnapshot } from '../git/merge';
import { GitRepository } from '../git/repository';

type Block = { start: number; end: number; ours: string; base?: string; theirs: string };
const { scanConflicts, chooseBlock, ignoreBlockSide } = require('../../media/mergeModel.js') as {
  scanConflicts(text: string, markerSize?: number): { blocks: Block[]; malformed: boolean };
  chooseBlock(block: Block, choice: 'ours' | 'theirs' | 'both'): string;
  ignoreBlockSide(block: Block, ignored: 'ours' | 'theirs' | undefined, side: 'ours' | 'theirs'):
    { ignored?: 'ours' | 'theirs'; replacement?: string } | undefined;
};

test('merge blocks preserve surrounding content and reject partial markers', () => {
  const original = 'before\n<<<<<<<<< Current\nours\n||||||||| Base\nbase\n=========\ntheirs\n>>>>>>>>> Incoming\nafter\n';
  const parsed = scanConflicts(original, 9);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.blocks.length, 1);
  const block = parsed.blocks[0]!;
  assert.equal(block.base, 'base\n');
  assert.equal(original.slice(0, block.start) + chooseBlock(block, 'both') + original.slice(block.end),
    'before\nours\ntheirs\nafter\n');
  assert.equal(scanConflicts(original.replace('>>>>>>>>> Incoming\n', ''), 9).malformed, true);
  assert.equal(scanConflicts('Title\n=======\n').malformed, false);
});

test('ignoring a merge side is reversible and two ignored sides require a known Base', () => {
  const block: Block = { start: 0, end: 0, ours: 'current\n', theirs: 'incoming\n' };
  assert.deepEqual(ignoreBlockSide(block, undefined, 'ours'), { ignored: 'ours' });
  assert.deepEqual(ignoreBlockSide(block, 'ours', 'ours'), { ignored: undefined });
  assert.equal(ignoreBlockSide(block, 'ours', 'theirs'), undefined);
  assert.deepEqual(ignoreBlockSide({ ...block, base: 'original\n' }, 'theirs', 'ours'), { replacement: 'original\n' });
  assert.deepEqual(ignoreBlockSide({ ...block, base: '' }, 'ours', 'theirs'), { replacement: '' });
});

test('custom merge applies UTF-8 results, preserves line endings and handles deleted sides', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-smart-git-merge-'));
  const repo = new GitRepository(root);
  const file = 'report[2].ts';
  const absolute = path.join(root, file);
  const deletion = path.join(root, 'other.ts');
  const text = (value: string) => `export const mode = '${value}';\n`;
  try {
    await repo.run(['init', '-b', 'main']);
    await repo.run(['config', 'user.name', 'Merge Test']);
    await repo.run(['config', 'user.email', 'merge@example.test']);
    await repo.run(['config', 'merge.conflictStyle', 'diff3']);
    await writeFile(absolute, text('base'));
    await writeFile(deletion, text('base'));
    await repo.stageAll();
    await repo.commit('Base', false);
    await repo.createBranch('incoming');
    await writeFile(absolute, text('incoming'));
    await unlink(deletion);
    await repo.stageAll();
    await repo.commit('Incoming', false);
    await repo.switchBranch('main');
    await writeFile(absolute, text('current'));
    await writeFile(deletion, text('current'));
    await repo.stageAll();
    await repo.commit('Current', false);
    assert.notEqual((await repo.run(['merge', 'incoming'], { allowFailure: true })).exitCode, 0);

    const initial = await loadMergeSnapshot(repo, file);
    assert.equal(initial.base.text, text('base'));
    assert.equal(initial.ours.text, text('current'));
    assert.equal(initial.theirs.text, text('incoming'));
    assert.equal(scanConflicts(initial.working.text!).blocks.length, 1);
    await assert.rejects(applyMergeResult(repo, initial, initial.working.text!), /remaining conflict markers/);

    await writeFile(absolute, '\ufeff' + initial.working.text!.replace(/\n/g, '\r\n'));
    await assert.rejects(applyMergeResult(repo, initial, text('stale')), /changed on disk/);
    const updated = await loadMergeSnapshot(repo, file);
    const similar = path.join(root, 'report2.ts');
    await writeFile(similar, 'leave this file untracked\n');
    await applyMergeResult(repo, updated, text('resolved'));
    assert.equal(await readFile(absolute, 'utf8'), '\ufeff' + text('resolved').replace(/\n/g, '\r\n'));
    let status = await repo.status();
    assert.equal(status.changes.find((change) => change.path === file)?.hasStagedChange, true);
    assert.equal(status.changes.find((change) => change.path === 'report2.ts')?.kind, 'untracked');
    await assert.rejects(applyMergeResult(repo, updated, text('second attempt')), /changed on disk or in the index/);

    const deleted = await loadMergeSnapshot(repo, 'other.ts');
    assert.equal(deleted.theirs.present, false);
    await acceptMergeSide(repo, deleted, 'theirs');
    await assert.rejects(readFile(deletion), { code: 'ENOENT' });
    status = await repo.status();
    assert.equal(status.changes.find((change) => change.path === 'other.ts')?.kind, 'deleted');
    assert.equal(status.changes.some((change) => change.conflicted), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
