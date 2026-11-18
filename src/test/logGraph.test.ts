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
