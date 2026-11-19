import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitRepository } from '../git/repository';

test('Log filters use Git reachability and match authors before limiting results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-smart-git-log-'));
  const repository = new GitRepository(root);
  try {
    await repository.run(['init', '-b', 'main']);
    await repository.run(['config', 'user.name', 'Sam (Dev)']);
    await repository.run(['config', 'user.email', 'sam+main@example.test']);
    assert.deepEqual(await repository.log(200), []);
    assert.deepEqual(await repository.logAuthors(), []);
    await repository.run(['commit', '--allow-empty', '-m', 'Base']);
    await repository.createBranch('feature/search');
    await repository.run(['commit', '--allow-empty', '--author=Sam (Dev) <sam+remote@example.test>', '-m', 'Remote tip']);
    const { stdout: head } = await repository.run(['rev-parse', 'HEAD']);
    await repository.run(['update-ref', 'refs/remotes/origin/feature/search', head.trim()]);
    await repository.createTag('preview/v1', head.trim());
    await repository.switchBranch('main');
    await repository.run(['branch', '-D', 'feature/search']);
    await repository.run(['commit', '--allow-empty', '-m', 'Main tip']);
    await writeFile(path.join(root, '.mailmap'), 'Sam (Dev) <sam+mapped@example.test> <sam+remote@example.test>\n');

    const all = await repository.log(10);
    assert.deepEqual(new Set(all.map((commit) => commit.subject)), new Set(['Base', 'Remote tip', 'Main tip']));
    assert.deepEqual((await repository.log(10, { ref: 'HEAD' })).map((commit) => commit.subject), ['Main tip', 'Base']);
    assert.deepEqual((await repository.log(10, { ref: 'refs/remotes/origin/feature/search' })).map((commit) => commit.subject), ['Remote tip', 'Base']);
    assert.deepEqual((await repository.log(1, { ref: 'refs/tags/preview/v1' })).map((commit) => commit.subject), ['Remote tip']);
    assert.deepEqual(await repository.tags(), [{ ref: 'refs/tags/preview/v1', name: 'preview/v1' }]);

    const authors = await repository.logAuthors();
    assert.deepEqual(new Set(authors.map((author) => author.email)), new Set(['sam+main@example.test', 'sam+mapped@example.test']));
    const mainAuthor = authors.find((author) => author.email === 'sam+main@example.test');
    const remoteAuthor = authors.find((author) => author.email === 'sam+mapped@example.test');
    assert.ok(mainAuthor && remoteAuthor);
    assert.deepEqual((await repository.log(1, { ref: 'refs/remotes/origin/feature/search', author: mainAuthor })).map((commit) => commit.subject), ['Base']);
    assert.deepEqual((await repository.log(1, { author: remoteAuthor })).map((commit) => commit.subject), ['Remote tip']);
    assert.deepEqual(await repository.log(10, { ref: 'HEAD', author: remoteAuthor }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitRepository completes local change, history, and conflict workflows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-smart-git-test-'));
  const repository = new GitRepository(root);
  try {
    await repository.run(['init', '-b', 'main']);
    await repository.run(['config', 'user.name', 'VC Smart Git Test']);
    await repository.run(['config', 'user.email', 'vc-smart-git@example.test']);

    await writeFile(path.join(root, 'shared.txt'), 'base\n');
    await writeFile(path.join(root, 'delete-me.txt'), 'tracked file\n');
    await repository.stageAll();
    await repository.commit('Initial commit', false);

    const initialHash = (await repository.run(['rev-parse', 'HEAD'])).stdout.trim();
    const initialCommit = await repository.commitByHash(initialHash);
    assert.equal(initialCommit?.subject, 'Initial commit');
    assert.equal(initialCommit?.authorName, 'VC Smart Git Test');
    await repository.run(['remote', 'add', 'origin', 'git@github.com:example/vc-smart-git.git']);
    assert.equal(await repository.remoteUrl(), 'git@github.com:example/vc-smart-git.git');

    const initialBlame = await repository.blame('shared.txt', 'base\n');
    assert.equal(initialBlame[0]?.author, 'VC Smart Git Test');
    assert.equal(initialBlame[0]?.summary, 'Initial commit');
    const modifiedBlame = await repository.blame('shared.txt', 'not committed\n');
    assert.equal(modifiedBlame[0]?.uncommitted, true);
    assert.equal(modifiedBlame[0]?.content, 'not committed');

    await unlink(path.join(root, 'delete-me.txt'));
    let status = await repository.status();
    const deleted = status.changes.find((change) => change.path === 'delete-me.txt');
    assert.equal(deleted?.kind, 'deleted');
    assert.equal(deleted?.worktreeStatus, 'D');
    assert.equal(deleted?.hasWorkingTreeChange, true);
    await repository.rollbackTracked(['delete-me.txt']);
    assert.equal(await readFile(path.join(root, 'delete-me.txt'), 'utf8'), 'tracked file\n');

    await writeFile(path.join(root, 'shared.txt'), 'working tree\n');
    await writeFile(path.join(root, 'untracked.txt'), 'new\n');
    status = await repository.status();
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

    await repository.stage(['shared.txt']);
    await writeFile(path.join(root, 'shared.txt'), 'working tree after staging\n');
    await repository.rollbackTracked(['shared.txt']);
    assert.equal(await readFile(path.join(root, 'shared.txt'), 'utf8'), 'base\n');
    status = await repository.status();
    assert.equal(status.changes.some((change) => change.path === 'shared.txt'), false);
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

    const contentConflicts = await repository.conflicts(status, 'merge');
    assert.equal(contentConflicts.currentBranch, 'main');
    assert.equal(contentConflicts.incomingLabel, 'other');
    assert.equal(contentConflicts.files[0]?.path, 'shared.txt');
    assert.equal(contentConflicts.files[0]?.ours, 'Modified');
    assert.equal(contentConflicts.files[0]?.theirs, 'Modified');
    assert.equal(contentConflicts.files[0]?.oursAvailable, true);
    assert.equal(contentConflicts.files[0]?.theirsAvailable, true);
    assert.equal(contentConflicts.files[0]?.simple, false);

    const simpleDeletedConflict = await repository.conflicts({
      ...status,
      changes: [{
        ...status.changes[0]!,
        indexStatus: 'D',
        worktreeStatus: 'D',
      }],
    });
    assert.equal(simpleDeletedConflict.files[0]?.simple, true);
    assert.equal(simpleDeletedConflict.files[0]?.simpleReason, 'bothDeleted');

    await repository.useConflictSide('shared.txt', 'theirs');
    status = await repository.status();
    assert.equal(status.changes.find((change) => change.path === 'shared.txt')?.hasStagedChange, true);
    await repository.abortOperation('merge');
    assert.equal(await repository.operation(), undefined);

    await repository.createBranch('delete-other');
    await unlink(path.join(root, 'shared.txt'));
    await repository.stageAll();
    await repository.commit('Delete on other', false);
    await repository.switchBranch('main');
    await writeFile(path.join(root, 'shared.txt'), 'main keeps the file\n');
    await repository.stageAll();
    await repository.commit('Modify before deletion merge', false);
    const deleteMerge = await repository.run(['merge', 'delete-other'], { allowFailure: true });
    assert.notEqual(deleteMerge.exitCode, 0);
    status = await repository.status();
    const deleteConflictState = await repository.conflicts(status, 'merge');
    const deleteConflict = deleteConflictState.files.find((conflict) => conflict.path === 'shared.txt');
    assert.equal(deleteConflict?.oursAvailable, true);
    assert.equal(deleteConflict?.theirsAvailable, false);
    assert.equal(deleteConflict?.theirs, 'Deleted');
    await repository.useConflictSide('shared.txt', 'theirs', true);
    await assert.rejects(readFile(path.join(root, 'shared.txt'), 'utf8'));
    status = await repository.status();
    assert.equal(status.changes.find((change) => change.path === 'shared.txt')?.conflicted, false);
    assert.equal(status.changes.find((change) => change.path === 'shared.txt')?.kind, 'deleted');
    await repository.abortOperation('merge');
    assert.equal(await readFile(path.join(root, 'shared.txt'), 'utf8'), 'main keeps the file\n');

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
