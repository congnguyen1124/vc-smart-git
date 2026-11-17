import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitRepository } from '../git/repository';

test('GitRepository completes local change, history, and conflict workflows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-smart-git-test-'));
  const repository = new GitRepository(root);
  try {
    await repository.run(['init', '-b', 'main']);
    await repository.run(['config', 'user.name', 'VC Smart Git Test']);
    await repository.run(['config', 'user.email', 'vc-smart-git@example.test']);

    await writeFile(path.join(root, 'shared.txt'), 'base\n');
    await repository.stageAll();
    await repository.commit('Initial commit', false);

    await writeFile(path.join(root, 'shared.txt'), 'working tree\n');
    await writeFile(path.join(root, 'untracked.txt'), 'new\n');
    let status = await repository.status();
    assert.equal(status.branch, 'main');
    assert.equal(status.changes.find((change) => change.path === 'shared.txt')?.worktreeStatus, 'M');
    assert.equal(status.changes.find((change) => change.path === 'untracked.txt')?.kind, 'untracked');
    const workingDiff = await repository.diff('shared.txt', false, false);
    assert.match(workingDiff, /\+working tree/);

    await repository.stage(['untracked.txt']);
    status = await repository.status();
    assert.equal(status.changes.find((change) => change.path === 'untracked.txt')?.hasStagedChange, true);
    await repository.unstage(['untracked.txt']);
    status = await repository.status();
    assert.equal(status.changes.find((change) => change.path === 'untracked.txt')?.kind, 'untracked');

    await repository.discardTracked(['shared.txt']);
    await repository.run(['clean', '-f', '--', 'untracked.txt']);
    await repository.createBranch('other');
    await writeFile(path.join(root, 'shared.txt'), 'other branch\n');
    await repository.stageAll();
    await repository.commit('Change on other', false);
    await repository.switchBranch('main');
    await writeFile(path.join(root, 'shared.txt'), 'main branch\n');
    await repository.stageAll();
    await repository.commit('Change on main', false);

    const merge = await repository.run(['merge', 'other'], { allowFailure: true });
    assert.notEqual(merge.exitCode, 0);
    status = await repository.status();
    assert.equal(status.changes[0]?.conflicted, true);
    assert.equal(await repository.operation(), 'merge');

    await repository.useConflictSide('shared.txt', 'theirs');
    status = await repository.status();
    assert.equal(status.changes.find((change) => change.path === 'shared.txt')?.hasStagedChange, true);
    await repository.abortOperation('merge');
    assert.equal(await repository.operation(), undefined);

    const log = await repository.log(20);
    assert.ok(log.some((commit) => commit.subject === 'Initial commit'));
    assert.ok(log.some((commit) => commit.subject === 'Change on main'));
    const mainCommit = log.find((commit) => commit.subject === 'Change on main');
    assert.ok(mainCommit);
    const commitFiles = await repository.commitFiles(mainCommit.hash);
    assert.deepEqual(commitFiles, [{ status: 'M', path: 'shared.txt' }]);
    await writeFile(path.join(root, 'shared.txt'), 'local comparison\n');
    assert.deepEqual(await repository.filesAgainst(mainCommit.hash), [{ status: 'M', path: 'shared.txt' }]);
    await repository.resetHard(mainCommit.hash);
    assert.equal(await readFile(path.join(root, 'shared.txt'), 'utf8'), 'main branch\n');
    await repository.createTag('test-context-menu', mainCommit.hash);
    const tag = await repository.run(['rev-parse', 'test-context-menu']);
    assert.equal(tag.stdout.trim(), mainCommit.hash);
    const branches = await repository.branches();
    assert.ok(branches.some((branch) => branch.name === 'main' && branch.current));
    assert.ok(branches.some((branch) => branch.name === 'other'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
