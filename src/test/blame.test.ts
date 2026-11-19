
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlamePorcelain } from '../git/blame';
import { blameBackgrounds } from '../vscode/blameColors';

test('blame background favors green for recent committed dates and excludes local changes', () => {
  const colors = blameBackgrounds([
    { authorTime: 100, uncommitted: false },
    { authorTime: 200, uncommitted: false },
    { authorTime: 300, uncommitted: false },
    { authorTime: 300, uncommitted: false },
    { authorTime: 900, uncommitted: true },
    { authorTime: 0, uncommitted: false },
  ]);
  assert.deepEqual([...colors], [
    [100, 'rgba(160, 94, 91, 0.18)'],
    [200, 'rgba(101, 117, 132, 0.22)'],
    [300, 'rgba(35, 153, 89, 0.38)'],
  ]);
  assert.equal(blameBackgrounds([{ authorTime: 100, uncommitted: false }]).get(100), colors.get(200));
});

test('parseBlamePorcelain reads committed and working-tree lines', () => {
  const output = [
    '0123456789abcdef0123456789abcdef01234567 1 1 1',
    'author Cong Nguyen',
    'author-mail <cong@example.test>',
    'author-time 1794883200',
    'author-tz +0700',
    'summary Add Git blame annotations',
    'filename src/extension.ts',
    '\tcommitted line',
    '0000000000000000000000000000000000000000 2 2 1',
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 1794886800',
    'author-tz +0700',
    'summary Version of src/extension.ts from src/extension.ts',
    'filename src/extension.ts',
    '\tworking line',
    '',
  ].join('\n');

  const lines = parseBlamePorcelain(output);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.author, 'Cong Nguyen');
  assert.equal(lines[0]?.authorEmail, 'cong@example.test');
  assert.equal(lines[0]?.summary, 'Add Git blame annotations');
  assert.equal(lines[0]?.content, 'committed line');
  assert.equal(lines[0]?.uncommitted, false);
  assert.equal(lines[1]?.finalLine, 2);
  assert.equal(lines[1]?.uncommitted, true);
});
