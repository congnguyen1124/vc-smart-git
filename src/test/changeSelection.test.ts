import assert from 'node:assert/strict';
import test from 'node:test';

interface SelectionResult {
  keys: string[];
  anchorKey?: string;
}

const { resolveChangeSelection } = require('../../media/changeSelection.js') as {
  resolveChangeSelection(
    order: string[],
    currentKeys: string[],
    anchorKey: string | undefined,
    targetKey: string,
    modifiers?: { range?: boolean; toggle?: boolean; additive?: boolean },
  ): SelectionResult;
};

const order = ['unstaged:a.ts', 'staged:b.ts', 'unstaged:c.ts', 'unstaged:new.ts'];

test('change selection extends a range across change groups', () => {
  const result = resolveChangeSelection(order, ['unstaged:a.ts'], 'unstaged:a.ts', 'unstaged:new.ts', { range: true });
  assert.deepEqual(result.keys, order);
  assert.equal(result.anchorKey, 'unstaged:a.ts');
});

test('change selection toggles individual files without losing the original selection', () => {
  const added = resolveChangeSelection(order, ['unstaged:a.ts'], 'unstaged:a.ts', 'unstaged:c.ts', { toggle: true });
  assert.deepEqual(added.keys, ['unstaged:a.ts', 'unstaged:c.ts']);

  const removed = resolveChangeSelection(order, added.keys, added.anchorKey, 'unstaged:a.ts', { toggle: true });
  assert.deepEqual(removed.keys, ['unstaged:c.ts']);
});

test('change selection keeps at least one file active', () => {
  const result = resolveChangeSelection(order, ['unstaged:a.ts'], 'unstaged:a.ts', 'unstaged:a.ts', { toggle: true });
  assert.deepEqual(result.keys, ['unstaged:a.ts']);
});
