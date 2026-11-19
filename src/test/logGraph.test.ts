import assert from 'node:assert/strict';
import test from 'node:test';

interface GraphRow {
  currentLane: number;
  continuations: Array<{ from: number; to: number }>;
  parentConnections: Array<{ to: number }>;
  merge: boolean;
}

interface GraphLayout {
  rows: GraphRow[];
  maxLaneCount: number;
}

const { layoutCommitGraph } = require('../../media/logGraph.js') as {
  layoutCommitGraph(commits: Array<{ hash: string; parents: string[] }>): GraphLayout;
  commitRefPresentations(
    commit: { hash: string; refs: string[] },
    branches: Array<{ hash: string; name: string; current: boolean; remote: boolean; worktreePath?: string }>,
    status: { oid?: string },
  ): Array<{ label: string; type: string; title: string }>;
  resizeLogPanes(
    containerWidth: number,
    currentLeft: number,
    currentRight: number,
    side: 'left' | 'right',
    requestedWidth: number,
  ): { left: number; right: number };
};

const { commitRefPresentations, resizeLogPanes } = require('../../media/logGraph.js') as {
  commitRefPresentations: (
    commit: { hash: string; refs: string[] },
    branches: Array<{ hash: string; name: string; current: boolean; remote: boolean; worktreePath?: string }>,
    status: { oid?: string },
  ) => Array<{ label: string; type: string; title: string }>;
  resizeLogPanes: (
    containerWidth: number,
    currentLeft: number,
    currentRight: number,
    side: 'left' | 'right',
    requestedWidth: number,
  ) => { left: number; right: number };
};

test('layoutCommitGraph creates and rejoins lanes for a merge history', () => {
  const layout = layoutCommitGraph([
    { hash: 'merge', parents: ['main-parent', 'feature-parent'] },
    { hash: 'feature-parent', parents: ['base'] },
    { hash: 'main-parent', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);

  assert.equal(layout.rows.length, 4);
  assert.equal(layout.rows[0]?.merge, true);
  assert.deepEqual(layout.rows[0]?.parentConnections.map((connection) => connection.to), [0, 1]);
  assert.ok(layout.maxLaneCount >= 2);
  assert.ok(layout.rows.some((row) => row.continuations.some((connection) => connection.from !== connection.to)));
});

test('layoutCommitGraph keeps a linear history in one lane', () => {
  const layout = layoutCommitGraph([
    { hash: 'three', parents: ['two'] },
    { hash: 'two', parents: ['one'] },
    { hash: 'one', parents: [] },
  ]);

  assert.equal(layout.maxLaneCount, 1);
  assert.deepEqual(layout.rows.map((row) => row.currentLane), [0, 0, 0]);
});

test('commit refs distinguish current, slash-named local, remote, worktree, and tag refs', () => {
  const refs = commitRefPresentations(
    { hash: 'abc', refs: ['HEAD -> feat/calendar', 'origin/feat/calendar', 'origin/HEAD -> origin/feat/calendar', 'tag: v1.2.0'] },
    [
      { hash: 'abc', name: 'feat/calendar', current: true, remote: false },
      { hash: 'abc', name: 'release/next', current: false, remote: false, worktreePath: '/work/release' },
      { hash: 'abc', name: 'origin/feat/calendar', current: false, remote: true },
    ],
    { oid: 'abc' },
  );

  assert.deepEqual(refs.map(({ label, type }) => ({ label, type })), [
    { label: 'HEAD \u2192 feat/calendar', type: 'head' },
    { label: 'release/next', type: 'worktree' },
    { label: 'origin/feat/calendar', type: 'remote' },
    { label: 'v1.2.0', type: 'tag' },
  ]);
});

test('log pane resizing preserves readable minimum widths', () => {
  assert.deepEqual(resizeLogPanes(1200, 250, 300, 'left', 500), { left: 500, right: 300 });
  assert.deepEqual(resizeLogPanes(900, 250, 250, 'left', 600), { left: 320, right: 250 });
  assert.deepEqual(resizeLogPanes(900, 250, 250, 'right', 600), { left: 250, right: 320 });
});
