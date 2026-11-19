import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptMergeSide, applyMergeResult, loadMergeSnapshot } from '../git/merge';
import { GitRepository } from '../git/repository';

type Block = { start: number; end: number; startLine: number; endLine: number; ours: string; base?: string; theirs: string };
const {
  scanConflicts, chooseBlock, ignoreBlockSide, conflictKey, resolveSimpleBlock,
  splitLines, changeColors, createPaneLayout, mapRow, paneRow,
} = require('../../media/mergeModel.js') as {
  scanConflicts(text: string, markerSize?: number): { blocks: Block[]; malformed: boolean };
  chooseBlock(block: Block, choice: 'ours' | 'theirs' | 'both'): string;
  ignoreBlockSide(block: Block, ignored: 'ours' | 'theirs' | undefined, side: 'ours' | 'theirs'):
    { ignored?: 'ours' | 'theirs'; replacement?: string } | undefined;
  conflictKey(block: Block): string;
  resolveSimpleBlock(block: Pick<Block, 'base' | 'ours' | 'theirs'>): string | undefined;
  splitLines(text: string): string[];
  changeColors(base: string[] | undefined, lines: string[]):
    { kinds: Array<string | undefined>; removed: Map<number, number> };
  createPaneLayout(result: string[], source: string[], pad: boolean, blocks?: Block[]): { height: number };
  mapRow(layout: { height: number }, row: number, toResult: boolean): number;
  paneRow(layout: { height: number }, row: number): { source: number; gap: boolean } | undefined;
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
  const block: Block = { start: 0, end: 0, startLine: 0, endLine: 0, ours: 'current\n', theirs: 'incoming\n' };
  assert.deepEqual(ignoreBlockSide(block, undefined, 'ours'), { ignored: 'ours' });
  assert.deepEqual(ignoreBlockSide(block, 'ours', 'ours'), { ignored: undefined });
  assert.equal(ignoreBlockSide(block, 'ours', 'theirs'), undefined);
  assert.deepEqual(ignoreBlockSide({ ...block, base: 'original\n' }, 'theirs', 'ours'), { replacement: 'original\n' });
  assert.deepEqual(ignoreBlockSide({ ...block, base: '' }, 'ours', 'theirs'), { replacement: '' });
});

test('simple conflict resolution combines independent edits and rejects overlapping or ambiguous edits', () => {
  assert.equal(resolveSimpleBlock({
    base: 'const options = { count: 1, mode: "sync" };\n',
    ours: 'const options = { count: 2, mode: "sync" };\n',
    theirs: 'const options = { count: 1, mode: "async" };\n',
  }), 'const options = { count: 2, mode: "async" };\n');
  assert.equal(resolveSimpleBlock({ ours: '', theirs: '', base: 'deleted\n' }), '');
  assert.equal(resolveSimpleBlock({ ours: 'unchanged\n', base: 'unchanged\n', theirs: 'updated\n' }), 'updated\n');
  assert.equal(resolveSimpleBlock({ ours: 'same\n', theirs: 'same\n' }), 'same\n');
  assert.equal(resolveSimpleBlock({ ours: 'first\n', theirs: 'second\n' }), undefined);
  assert.equal(resolveSimpleBlock({ base: 'value\n', ours: 'valued\n', theirs: 'Value\n' }), undefined);
  assert.equal(resolveSimpleBlock({ base: 'a a a\n', ours: 'a a\n', theirs: 'a a b\n' }), undefined);
  assert.equal(resolveSimpleBlock({ base: 'line\n', ours: 'first line\n', theirs: 'second line\n' }), undefined);
  assert.equal(resolveSimpleBlock({ base: 'text\n', ours: '', theirs: 'edited text\n' }), undefined);
});

test('ordinary Git conflict markers recover only reproducible ancestor chunks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-smart-git-plain-merge-'));
  const repo = new GitRepository(root);
  const file = 'options.ts';
  const absolute = path.join(root, file);
  const content = (count: number, mode: string) => `const options = { count: ${count}, mode: "${mode}" };\n`;
  try {
    await repo.run(['init', '-b', 'main']);
    await repo.run(['config', 'user.name', 'Merge Test']);
    await repo.run(['config', 'user.email', 'merge@example.test']);
    await repo.run(['config', 'merge.conflictStyle', 'merge']);
    await repo.run(['config', 'rerere.enabled', 'false']);
    await writeFile(absolute, content(1, 'sync'));
    await repo.stageAll();
    await repo.commit('Base', false);
    await repo.createBranch('incoming');
    await writeFile(absolute, content(1, 'async'));
    await repo.stageAll();
    await repo.commit('Incoming', false);
    await repo.switchBranch('main');
    await writeFile(absolute, content(2, 'sync'));
    await repo.stageAll();
    await repo.commit('Current', false);
    assert.notEqual((await repo.run(['merge', 'incoming'], { allowFailure: true })).exitCode, 0);
    const snapshot = await loadMergeSnapshot(repo, file);
    const { blocks } = scanConflicts(snapshot.working.text!);
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    assert.equal(block.base, undefined);
    const base = new Map(snapshot.conflictBases).get(conflictKey(block));
    assert.equal(base, content(1, 'sync'));
    assert.equal(resolveSimpleBlock({ ...block, base }), content(2, 'async'));
    assert.equal(await readFile(absolute, 'utf8'), snapshot.working.text);
    assert.match((await repo.run(['ls-files', '-u'])).stdout, /options\.ts/);
    await writeFile(absolute, '// manually edited context\n' + snapshot.working.text);
    assert.deepEqual((await loadMergeSnapshot(repo, file)).conflictBases, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merge colors distinguish additions, replacements and deletions against Base', () => {
  const base = splitLines('first\nreplace me\nnext\nremove me\nlast\n');
  const lines = splitLines('first\nreplacement\nnext\nlast\naddition\n\n');
  const { kinds, removed } = changeColors(base, lines);
  assert.deepEqual(Array.from(kinds), [undefined, 'modified', undefined, undefined, 'added', 'added']);
  assert.deepEqual([...removed], [[3, 1]]);
  assert.deepEqual([...changeColors(base, []).removed], [[0, 5]]);
  assert.equal(changeColors([], lines).kinds[0], 'added');
  assert.equal(changeColors(undefined, lines).kinds.length, 0);
});

test('merge pane mapping follows matching rows even after unequal hunks and for long revisions', () => {
  const suffix = Array.from({ length: 2100 }, (_, index) => `context ${index}`);
  const result = ['header', 'new result', 'common', 'one new line', 'another new line', ...suffix];
  const source = ['header', 'old 1', 'old 2', 'common', ...suffix];
  const aligned = createPaneLayout(result, source, true);
  const full = createPaneLayout(result, source, false);
  assert.equal(mapRow(aligned, 2, false), 3);
  assert.equal(mapRow(full, 2, false), 3);
  assert.deepEqual(paneRow(aligned, 4), { source: 4, gap: true });
  assert.equal(mapRow(aligned, 5, false), 6);
  assert.equal(mapRow(full, 5, false), 4);
  assert.equal(mapRow(aligned, 2000, true), 1999);
  assert.equal(mapRow(full, 2000, true), 2001);
  const empty = createPaneLayout(result, [], true);
  assert.deepEqual(paneRow(empty, 2000), { source: 0, gap: true });
  assert.equal(mapRow(empty, 2000.5, true), 2000.5);
});

test('Current and Incoming start the same conflict at the same visual row', () => {
  const working = 'header\n<<<<<<< HEAD\ncurrent\n=======\nincoming\nextra\n>>>>>>> topic\nshared\n';
  const { blocks } = scanConflicts(working);
  const lines = splitLines(working);
  const current = createPaneLayout(lines, ['header', 'current', 'shared'], true, blocks);
  const incoming = createPaneLayout(lines, ['header', 'incoming', 'extra', 'shared'], true, blocks);
  assert.deepEqual(paneRow(current, 1), { source: 1, gap: false });
  assert.deepEqual(paneRow(incoming, 1), { source: 1, gap: false });
  assert.deepEqual(paneRow(current, 2), { source: 2, gap: true });
  assert.deepEqual(paneRow(incoming, 2), { source: 2, gap: false });
  assert.deepEqual(paneRow(current, 7), { source: 2, gap: false });
  assert.deepEqual(paneRow(incoming, 7), { source: 3, gap: false });
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
