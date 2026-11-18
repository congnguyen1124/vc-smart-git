import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBranches, parseLog, parsePorcelainV2 } from '../git/parsers';

test('parsePorcelainV2 reads branch metadata and every change class', () => {
  const output = [
    '# branch.oid abcdef1234567890',
    '# branch.head feature/smart-git',
    '# branch.upstream origin/feature/smart-git',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/file with spaces.ts',
    '1 A. N... 000000 100644 100644 0000000 ccccccc staged.ts',
    '1 .D N... 100644 100644 000000 aaaaaaa 0000000 deleted-working-tree.ts',
    '1 D. N... 100644 000000 000000 aaaaaaa 0000000 deleted-staged.ts',
    '2 R. N... 100644 100644 100644 ddddddd eeeeeee R100 renamed.ts',
    'old name.ts',
    'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.ts',
    '? untracked file.txt',
    '',
  ].join('\0');

  const status = parsePorcelainV2(output);
  assert.equal(status.branch, 'feature/smart-git');
  assert.equal(status.upstream, 'origin/feature/smart-git');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 3);
  assert.equal(status.changes.length, 7);
  assert.equal(status.changes[0]?.path, 'conflict.ts');
  assert.equal(status.changes[0]?.conflicted, true);

  const renamed = status.changes.find((change) => change.path === 'renamed.ts');
  assert.equal(renamed?.originalPath, 'old name.ts');
  assert.equal(renamed?.kind, 'renamed');
  assert.equal(renamed?.hasStagedChange, true);

  const untracked = status.changes.find((change) => change.path === 'untracked file.txt');
  assert.equal(untracked?.kind, 'untracked');
  assert.equal(untracked?.hasWorkingTreeChange, true);

  const deletedWorkingTree = status.changes.find((change) => change.path === 'deleted-working-tree.ts');
  assert.equal(deletedWorkingTree?.kind, 'deleted');
  assert.equal(deletedWorkingTree?.hasWorkingTreeChange, true);
  assert.equal(deletedWorkingTree?.hasStagedChange, false);

  const deletedStaged = status.changes.find((change) => change.path === 'deleted-staged.ts');
  assert.equal(deletedStaged?.kind, 'deleted');
  assert.equal(deletedStaged?.hasWorkingTreeChange, false);
  assert.equal(deletedStaged?.hasStagedChange, true);
});

test('parseLog preserves commit bodies and decorations', () => {
  const output = [
    '0123456789abcdef',
    '0123456',
    'fedcba9876543210',
    'Ada Lovelace',
    'ada@example.test',
    '2026-11-17T10:00:00+07:00',
    'HEAD -> main, tag: v1.0.0',
    'Build the Git window',
    'First line\n\nSecond line',
  ].join('\0') + '\x1e';

  const commits = parseLog(output);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.subject, 'Build the Git window');
  assert.deepEqual(commits[0]?.refs, ['HEAD -> main', 'tag: v1.0.0']);
  assert.match(commits[0]?.body ?? '', /Second line/);
});

test('parseBranches distinguishes local and remote refs', () => {
  const output = [
    'refs/heads/main\0main\0*\0origin/main\0=\0abc123\x002026-11-17T10:00:00+07:00',
    'refs/remotes/origin/main\0origin/main\0\0\0\0abc123\x002026-11-17T10:00:00+07:00',
  ].join('\n');
  const branches = parseBranches(output);
  assert.equal(branches[0]?.current, true);
  assert.equal(branches[0]?.remote, false);
  assert.equal(branches[1]?.remote, true);
});
