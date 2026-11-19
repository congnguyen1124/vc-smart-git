import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptMergeSide, applyMergeResult, loadMergeSnapshot } from '../git/merge';
import { GitRepository } from '../git/repository';

type Block = { start: number; end: number; startLine: number; endLine: number; ours: string; base?: string; theirs: string };
type Side = 'ours' | 'theirs';
type DraftBlock = { start: number; end: number; original: Block; ours: string | null; theirs: string | null; manual: boolean };
type Draft = { text: string; blocks: DraftBlock[] };
type Region = { startLine: number; endLine: number };
type OffsetRange = { start: number; end: number };
const {
  scanConflicts, conflictKey, resolveSimpleBlock, createDraft, isPending, resolveBlock, resolveSimpleDraft, editDraft,
  draftRegions, splitLines, changeColors, sourceRanges, createPaneLayout, mapRow, paneRow,
} = require('../../media/mergeModel.js') as {
  scanConflicts(text: string, markerSize?: number): { blocks: Block[]; malformed: boolean };
  conflictKey(block: Block): string;
  resolveSimpleBlock(block: Pick<Block, 'base' | 'ours' | 'theirs'>): string | undefined;
  createDraft(text: string, markerSize: number, bases: Map<string, string>, noAncestor: boolean): Draft;
  isPending(block: DraftBlock): boolean;
  resolveBlock(draft: Draft, index: number, choice: 'take' | 'ignore' | 'keep' | 'base', side?: Side): Draft;
  resolveSimpleDraft(draft: Draft): { draft: Draft; count: number };
  editDraft(draft: Draft, text: string, selection: OffsetRange | undefined, caret: number): Draft;
  draftRegions(draft: Draft): Region[];
  splitLines(text: string): string[];
  changeColors(base: string[] | undefined, lines: string[]):
    { kinds: Array<string | undefined>; removed: Map<number, number> };
  sourceRanges(working: string[], source: string[], blocks: Block[]): OffsetRange[];
  createPaneLayout(result: string[], source: string[], pad: boolean, regions?: Region[], ranges?: OffsetRange[]): { height: number };
  mapRow(layout: { height: number }, row: number, toResult: boolean): number;
  paneRow(layout: { height: number }, row: number): { source: number; gap: boolean; conflict?: number; first?: boolean } | undefined;
};

const blockText = (ours: string, theirs: string, base?: string): string =>
  `<<<<<<< Current\n${ours}${base === undefined ? '' : `||||||| Base\n${base}`}=======\n${theirs}>>>>>>> Incoming\n`;

test('merge blocks preserve surrounding content and reject partial markers', () => {
  const original = 'before\n<<<<<<<<< Current\nours\n||||||||| Base\nbase\n=========\ntheirs\n>>>>>>>>> Incoming\nafter\n';
  const parsed = scanConflicts(original, 9);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.blocks.length, 1);
  const block = parsed.blocks[0]!;
  assert.equal(block.base, 'base\n');
  assert.equal(scanConflicts(original.replace('>>>>>>>>> Incoming\n', ''), 9).malformed, true);
  assert.equal(scanConflicts('Title\n=======\n').malformed, false);
});

test('Result starts from Base and keeps each side actionable until it has a decision', () => {
  const initial = createDraft('merged before\n' + blockText('left\n', 'right\n', 'base\n') + 'merged after\n',
    7, new Map(), false);
  assert.equal(initial.text, 'merged before\nbase\nmerged after\n');
  const right = resolveBlock(initial, 0, 'take', 'theirs');
  assert.equal(right.text, 'merged before\nright\nmerged after\n');
  assert.equal(isPending(right.blocks[0]!), true);
  assert.equal(right.blocks[0]?.theirs, 'accepted');
  assert.equal(resolveBlock(right, 0, 'take', 'theirs'), right);
  const both = resolveBlock(right, 0, 'take', 'ours');
  assert.equal(both.text, 'merged before\nright\nleft\nmerged after\n');
  assert.equal(isPending(both.blocks[0]!), false);
  const ignored = resolveBlock(resolveBlock(initial, 0, 'ignore', 'ours'), 0, 'ignore', 'theirs');
  assert.equal(isPending(ignored.blocks[0]!), false);
  assert.equal(ignored.text, initial.text);
  assert.equal(resolveBlock(right, 0, 'ignore', 'ours').text, right.text);
  assert.equal(isPending(initial.blocks[0]!), true);
});

test('unknown Base stays pending after ignoring a side and add/add keeps a known empty Base', () => {
  const text = blockText('current\n', 'incoming\n');
  const initial = createDraft(text, 7, new Map(), false);
  const ignored = resolveBlock(initial, 0, 'ignore', 'ours');
  assert.equal(resolveBlock(ignored, 0, 'ignore', 'theirs'), ignored);
  const addAdd = createDraft(text, 7, new Map(), true);
  const resolved = resolveBlock(resolveBlock(addAdd, 0, 'ignore', 'ours'), 0, 'ignore', 'theirs');
  assert.equal(resolved.text, '');
  assert.equal(isPending(resolved.blocks[0]!), false);
});

test('manual edits and bulk resolution track conflict offsets without replacing accepted or edited text', () => {
  const first = blockText('let count = 2, mode = "sync";\n', 'let count = 1, mode = "async";\n',
    'let count = 1, mode = "sync";\n');
  const initial = createDraft('prefix\n' + first + 'middle\n' + blockText('current\n', 'incoming\n', 'original\n'), 7, new Map(), false);
  const { draft: combined, count } = resolveSimpleDraft(initial);
  assert.equal(count, 1);
  assert.match(combined.text, /count = 2, mode = "async"/);
  assert.equal(isPending(combined.blocks[1]!), true);
  const second = combined.blocks[1]!;
  const text = combined.text.slice(0, second.start) + 'edited by hand\n' + combined.text.slice(second.end);
  const edited = editDraft(combined, text, { start: second.start, end: second.end }, second.start + 'edited by hand\n'.length);
  assert.equal(edited.blocks[1]?.manual, true);
  const prefixed = editDraft(edited, 'comment\n' + edited.text, { start: 0, end: 0 }, 8);
  assert.equal(prefixed.blocks[1]?.start, second.start + 8);
  const kept = resolveBlock(prefixed, 1, 'keep');
  assert.equal(kept.text, 'comment\n' + text);
  assert.equal(kept.blocks.some(isPending), false);
  const appended = resolveBlock(prefixed, 1, 'take', 'theirs');
  assert.match(appended.text, /edited by hand\nincoming\n$/);
  assert.equal(resolveSimpleDraft(resolveBlock(initial, 0, 'take', 'ours')).count, 0);
});

test('taking a side after editing adjacent empty conflict ranges preserves draft text', () => {
  const initial = createDraft(blockText('first left\n', 'first right\n', '') +
    blockText('second left\n', 'second right\n', ''), 7, new Map(), false);
  const edited = editDraft(initial, 'manual\n', { start: 0, end: 0 }, 7);
  const second = resolveBlock(edited, 1, 'take', 'theirs');
  assert.equal(second.text, 'manual\nsecond right\n');
  const first = resolveBlock(second, 0, 'take', 'ours');
  assert.equal(first.text, 'manual\nfirst left\nsecond right\n');
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
    await writeFile(absolute, snapshot.working.text!);
    const restored = await loadMergeSnapshot(repo, file);
    const draft = createDraft(restored.working.text!, restored.markerSize, new Map(restored.conflictBases), false);
    const accepted = resolveBlock(draft, 0, 'take', 'theirs');
    assert.equal(isPending(accepted.blocks[0]!), true);
    const result = resolveBlock(accepted, 0, 'ignore', 'ours');
    await applyMergeResult(repo, restored, result.text);
    assert.equal(await readFile(absolute, 'utf8'), content(1, 'async'));
    assert.equal((await repo.run(['ls-files', '-u'])).stdout, '');
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
  const draft = createDraft(working, 7, new Map(), true);
  const regions = draftRegions(draft);
  const ours = ['header', 'current', 'shared'];
  const theirs = ['header', 'incoming', 'extra', 'shared'];
  const current = createPaneLayout(splitLines(draft.text), ours, true, regions, sourceRanges(splitLines(working), ours, blocks));
  const incoming = createPaneLayout(splitLines(draft.text), theirs, true, regions, sourceRanges(splitLines(working), theirs, blocks));
  assert.deepEqual(paneRow(current, 1), { source: 1, gap: false, conflict: 0, first: true });
  assert.deepEqual(paneRow(incoming, 1), { source: 1, gap: false, conflict: 0, first: true });
  assert.equal(mapRow(current, 1, false), 1);
  assert.equal(mapRow(incoming, 1, false), 1);
  assert.equal(mapRow(current, 2, true), 1);
  assert.equal(mapRow(incoming, 3, true), 1);
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
