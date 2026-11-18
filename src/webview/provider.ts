import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCommandError, GitRepository } from '../git/repository';
import type { GitBranch, GitCommit, GitOperation, GitStatus, RepositorySummary } from '../git/types';
import { GitContentProvider, resolveRepositoryPath } from '../vscode/diffProvider';
import { resolveMaterialIconPath, type MaterialIconThemeData } from '../vscode/materialIcons';
import { discoverRepositories } from '../vscode/repositoryDiscovery';
import { webviewContent } from './content';

interface ViewState {
  repositories: RepositorySummary[];
  activeRoot?: string;
  status?: GitStatus;
  commits: GitCommit[];
  branches: GitBranch[];
  operation?: GitOperation;
}

type ActionName =
  | 'refresh'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'stageAll'
  | 'unstageAll'
  | 'continueOperation'
  | 'abortOperation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(message: Record<string, unknown>, key: string): boolean {
  return message[key] === true;
}

function pathValues(message: Record<string, unknown>): string[] {
  const value = message.paths;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export class SmartGitViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private state: ViewState = { repositories: [], commits: [], branches: [] };
  private activeRepository: GitRepository | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private materialIconTheme: MaterialIconThemeData | undefined;
  private materialIconThemeLoading: Promise<void> | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly contentProvider: GitContentProvider,
    private readonly output: vscode.OutputChannel,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const materialIconExtension = this.materialIconExtension();
    void vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ...(materialIconExtension ? [materialIconExtension.extensionUri] : []),
      ],
    };
    view.webview.html = webviewContent(view.webview, this.context.extensionUri);
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    }, undefined, this.context.subscriptions);
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.scheduleRefresh(0);
      }
    }, undefined, this.context.subscriptions);
  }

  public scheduleRefresh(delay = 200): void {
    if (!vscode.workspace.getConfiguration('vcSmartGit').get('autoRefresh', true) && delay > 0) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  public async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.refreshState();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh(50);
      }
    }
  }

  public async runAction(action: ActionName): Promise<void> {
    switch (action) {
      case 'refresh': await this.refresh(); return;
      case 'fetch': await this.execute('Fetching all remotes', (repo) => repo.fetch(), 'Fetch complete'); return;
      case 'pull': await this.execute('Pulling changes', (repo) => repo.pull(), 'Pull complete'); return;
      case 'push': await this.push(); return;
      case 'stageAll': await this.execute('Staging all changes', (repo) => repo.stageAll()); return;
      case 'unstageAll': await this.execute('Unstaging all changes', (repo) => repo.unstageAll()); return;
      case 'continueOperation': await this.continueOperation(); return;
      case 'abortOperation': await this.abortOperation(); return;
    }
  }

  public async revealCommit(root: string, hash: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(hash)) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('workbench.view.extension.vcSmartGit');
    await vscode.commands.executeCommand('vcSmartGit.toolWindow.focus');
    await this.refresh();

    const repositoryRoot = this.state.repositories.find(
      (entry) => path.resolve(entry.root) === path.resolve(root),
    )?.root;
    if (!repositoryRoot) {
      void vscode.window.showWarningMessage('The blamed commit belongs to a repository that is not open in VC Smart Git.');
      return;
    }
    if (path.resolve(this.state.activeRoot ?? '') !== path.resolve(repositoryRoot)) {
      this.state.activeRoot = repositoryRoot;
      await this.context.workspaceState.update('vcSmartGit.activeRoot', repositoryRoot);
      await this.refresh();
    }
    if (!this.activeRepository) {
      return;
    }

    let commit = this.state.commits.find((entry) => entry.hash === hash);
    if (!commit) {
      commit = await this.activeRepository.commitByHash(hash);
      if (!commit) {
        void vscode.window.showWarningMessage(`Commit ${hash.slice(0, 8)} is no longer available in this repository.`);
        return;
      }
      this.state.commits = [...this.state.commits, commit]
        .sort((left, right) => Date.parse(right.authoredAt) - Date.parse(left.authoredAt));
      this.post({ type: 'appendCommit', commit });
    }
    this.post({ type: 'revealCommit', hash });
  }

  private async refreshState(): Promise<void> {
    this.post({ type: 'loading', value: true });
    try {
      await this.loadMaterialIconTheme();
      const gitPath = vscode.workspace.getConfiguration('vcSmartGit').get('gitPath', 'git');
      const repositories = await discoverRepositories(gitPath);
      const savedRoot = this.context.workspaceState.get<string>('vcSmartGit.activeRoot');
      const currentRoot = this.state.activeRoot ?? savedRoot;
      const activeRoot = repositories.some((entry) => entry.root === currentRoot)
        ? currentRoot
        : repositories[0]?.root;

      if (!activeRoot) {
        this.activeRepository = undefined;
        this.state = { repositories, commits: [], branches: [] };
        this.post({ type: 'state', state: this.state, fileIcons: {} });
        return;
      }

      const repository = new GitRepository(activeRoot, gitPath);
      const limit = vscode.workspace.getConfiguration('vcSmartGit').get('logLimit', 200);
      const [status, commits, branches, operation] = await Promise.all([
        repository.status(),
        repository.log(limit),
        repository.branches(),
        repository.operation(),
      ]);
      this.activeRepository = repository;
      this.state = {
        repositories,
        activeRoot,
        status,
        commits,
        branches,
        ...(operation ? { operation } : {}),
      };
      await this.context.workspaceState.update('vcSmartGit.activeRoot', activeRoot);
      this.post({
        type: 'state',
        state: this.state,
        fileIcons: this.fileIcons(status.changes.map((change) => change.path)),
      });
    } catch (error) {
      this.reportError('Unable to refresh the repository', error);
      this.post({ type: 'state', state: this.state, fileIcons: {} });
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async loadMaterialIconTheme(): Promise<void> {
    const extension = this.materialIconExtension();
    if (this.materialIconTheme || !extension) {
      return;
    }
    if (!this.materialIconThemeLoading) {
      this.materialIconThemeLoading = (async () => {
        try {
          const themeUri = vscode.Uri.joinPath(extension.extensionUri, 'dist', 'material-icons.json');
          const bytes = await vscode.workspace.fs.readFile(themeUri);
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as MaterialIconThemeData;
          if (!parsed.iconDefinitions || typeof parsed.iconDefinitions !== 'object') {
            throw new Error('Material Icon Theme does not expose icon definitions.');
          }
          this.materialIconTheme = parsed;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[${new Date().toISOString()}] Unable to load Material Icon Theme: ${detail}`);
        }
      })();
    }
    await this.materialIconThemeLoading;
  }

  private fileIcons(paths: readonly string[]): Record<string, string> {
    const theme = this.materialIconTheme;
    const extension = this.materialIconExtension();
    const webview = this.view?.webview;
    if (!theme || !extension || !webview) {
      return {};
    }
    const useLightVariant = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
      || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
    const result: Record<string, string> = {};
    for (const filePath of new Set(paths)) {
      const iconPath = resolveMaterialIconPath(filePath, theme, useLightVariant);
      if (!iconPath) {
        continue;
      }
      const absolute = path.resolve(extension.extensionPath, 'dist', iconPath);
      const relative = path.relative(extension.extensionPath, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        continue;
      }
      result[filePath] = webview.asWebviewUri(vscode.Uri.file(absolute)).toString();
    }
    return result;
  }

  private materialIconExtension(): vscode.Extension<unknown> | undefined {
    return vscode.extensions.all.find(
      (extension) => extension.id.toLowerCase() === 'pkief.material-icon-theme',
    );
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isRecord(value)) {
      return;
    }
    const type = stringValue(value, 'type');
    switch (type) {
      case 'ready': await this.refresh(); return;
      case 'refresh': case 'fetch': case 'pull': case 'push': case 'stageAll': case 'unstageAll': case 'continueOperation': case 'abortOperation':
        await this.runAction(type); return;
      case 'selectRepository': await this.selectRepository(stringValue(value, 'root')); return;
      case 'stage': await this.stage(pathValues(value)); return;
      case 'unstage': await this.unstage(pathValues(value)); return;
      case 'discard': await this.discard(pathValues(value)); return;
      case 'markResolved': await this.stage(pathValues(value)); return;
      case 'useOurs': await this.useConflictSide(pathValues(value), 'ours'); return;
      case 'useTheirs': await this.useConflictSide(pathValues(value), 'theirs'); return;
      case 'openMerge': await this.openMerge(pathValues(value)[0]); return;
      case 'previewDiff': await this.previewDiff(stringValue(value, 'path'), booleanValue(value, 'staged')); return;
      case 'openDiff': await this.openDiff(
        stringValue(value, 'path'),
        booleanValue(value, 'staged'),
        booleanValue(value, 'permanent'),
      ); return;
      case 'openSource': await this.openSource(stringValue(value, 'path')); return;
      case 'copyPath': await this.copyPath(stringValue(value, 'path')); return;
      case 'promptCommit': await this.promptCommit(); return;
      case 'switchBranch': await this.switchBranch(stringValue(value, 'branch')); return;
      case 'newBranch': await this.newBranch(); return;
      case 'newBranchFromRef': await this.newBranch(stringValue(value, 'ref')); return;
      case 'deleteBranch': await this.deleteBranch(stringValue(value, 'branch')); return;
      case 'copyText': await this.copyBranchName(stringValue(value, 'text')); return;
      case 'showCommit': await this.showCommit(stringValue(value, 'hash')); return;
      case 'openCommitDiff': await this.openCommitDiff(
        stringValue(value, 'hash'),
        stringValue(value, 'path'),
        stringValue(value, 'originalPath'),
      ); return;
      case 'branchFromCommit': await this.newBranch(stringValue(value, 'hash')); return;
      case 'tagFromCommit': await this.createTag(stringValue(value, 'hash')); return;
      case 'checkoutCommit': await this.checkoutCommit(stringValue(value, 'hash')); return;
      case 'compareWithLocal': await this.compareWithLocal(stringValue(value, 'hash')); return;
      case 'resetToCommit': await this.resetToCommit(stringValue(value, 'hash')); return;
      case 'cherryPick': await this.commitAction('Cherry-pick', stringValue(value, 'hash'), (repo, hash) => repo.cherryPick(hash)); return;
      case 'revertCommit': await this.commitAction('Revert', stringValue(value, 'hash'), (repo, hash) => repo.revert(hash)); return;
      case 'copyHash': await this.copyHash(stringValue(value, 'hash')); return;
    }
  }

  private async selectRepository(root: string | undefined): Promise<void> {
    if (!root || !this.state.repositories.some((entry) => entry.root === root)) {
      return;
    }
    this.state.activeRoot = root;
    await this.context.workspaceState.update('vcSmartGit.activeRoot', root);
    await this.refresh();
  }

  private validPaths(paths: readonly string[]): string[] {
    const known = new Set(this.state.status?.changes.map((change) => change.path) ?? []);
    return [...new Set(paths)].filter((candidate) => known.has(candidate));
  }

  private validHash(hash: string | undefined): hash is string {
    return Boolean(hash && /^[0-9a-f]{7,64}$/i.test(hash) && this.state.commits.some((commit) => commit.hash === hash));
  }

  private async stage(paths: readonly string[]): Promise<void> {
    const valid = this.validPaths(paths);
    if (valid.length > 0) {
      await this.execute('Staging changes', (repo) => repo.stage(valid));
    }
  }

  private async unstage(paths: readonly string[]): Promise<void> {
    const valid = this.validPaths(paths);
    if (valid.length > 0) {
      await this.execute('Unstaging changes', (repo) => repo.unstage(valid));
    }
  }

  private async discard(paths: readonly string[]): Promise<void> {
    const valid = this.validPaths(paths);
    if (valid.length === 0 || !this.activeRepository) {
      return;
    }
    const confirm = vscode.workspace.getConfiguration('vcSmartGit').get('confirmDestructiveActions', true);
    if (confirm) {
      const answer = await vscode.window.showWarningMessage(
        `Discard working tree changes in ${valid.length} file${valid.length === 1 ? '' : 's'}? Untracked files will be moved to Trash.`,
        { modal: true },
        'Discard Changes',
      );
      if (answer !== 'Discard Changes') {
        return;
      }
    }

    const changes = this.state.status?.changes ?? [];
    const untracked = valid.filter((candidate) => changes.find((change) => change.path === candidate)?.kind === 'untracked');
    const tracked = valid.filter((candidate) => !untracked.includes(candidate));
    await this.execute('Discarding changes', async (repo) => {
      await repo.discardTracked(tracked);
      for (const filePath of untracked) {
        const absolute = resolveRepositoryPath(repo.root, filePath);
        await vscode.workspace.fs.delete(vscode.Uri.file(absolute), { recursive: false, useTrash: true });
      }
    });
  }

  private async useConflictSide(paths: readonly string[], side: 'ours' | 'theirs'): Promise<void> {
    const valid = this.validPaths(paths).filter((candidate) => this.state.status?.changes.find((change) => change.path === candidate)?.conflicted);
    if (valid.length > 0) {
      await this.execute(`Accepting ${side}`, async (repo) => {
        for (const filePath of valid) {
          await repo.useConflictSide(filePath, side);
        }
      });
    }
  }

  private async openMerge(filePath: string | undefined): Promise<void> {
    if (!filePath || !this.activeRepository || !this.validPaths([filePath]).length) {
      return;
    }
    const uri = vscode.Uri.file(resolveRepositoryPath(this.activeRepository.root, filePath));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: false });
      void vscode.window.showInformationMessage('The Merge Editor was unavailable, so the conflicted file was opened in the text editor.');
    }
  }

  private async openDiff(filePath: string | undefined, staged: boolean, permanent = false): Promise<void> {
    const repository = this.activeRepository;
    const change = this.state.status?.changes.find((entry) => entry.path === filePath);
    if (!repository || !filePath || !change) {
      return;
    }
    if (change.conflicted) {
      await this.openMerge(filePath);
      return;
    }
    const sourcePath = change.originalPath ?? filePath;
    const leftContent = await repository.readBlob(staged ? 'HEAD' : ':', sourcePath);
    const left = this.contentProvider.create(leftContent, sourcePath, staged ? 'HEAD' : 'Index');
    let right: vscode.Uri;
    if (staged) {
      const indexContent = await repository.readBlob(':', filePath);
      right = this.contentProvider.create(indexContent, filePath, 'Index');
    } else if (change.kind === 'deleted') {
      right = this.contentProvider.create('', filePath, 'Deleted');
    } else {
      right = vscode.Uri.file(resolveRepositoryPath(repository.root, filePath));
    }
    const title = `${path.basename(filePath)} (${staged ? 'HEAD ↔ Index' : 'Index ↔ Working Tree'})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: !permanent });
  }

  private async openSource(filePath: string | undefined): Promise<void> {
    if (!filePath || !this.activeRepository || !this.validPaths([filePath]).length) {
      return;
    }
    const uri = vscode.Uri.file(resolveRepositoryPath(this.activeRepository.root, filePath));
    try {
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch (error) {
      this.reportError('Unable to open file', error);
    }
  }

  private async copyPath(filePath: string | undefined): Promise<void> {
    const knownChange = this.validPaths([filePath ?? '']).length > 0;
    if (!filePath || (!knownChange && !this.activeRepository)) {
      return;
    }
    await vscode.env.clipboard.writeText(filePath);
    this.post({ type: 'toast', message: 'Path copied' });
  }

  private async previewDiff(filePath: string | undefined, staged: boolean): Promise<void> {
    const repository = this.activeRepository;
    const change = this.state.status?.changes.find((entry) => entry.path === filePath);
    if (!repository || !filePath || !change) {
      return;
    }
    try {
      let diff = await repository.diff(filePath, staged, change.conflicted);
      if (!diff && change.kind === 'untracked') {
        const absolute = resolveRepositoryPath(repository.root, filePath);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolute));
        const content = new TextDecoder().decode(bytes);
        diff = [
          'diff --git /dev/null b/' + filePath,
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/' + filePath,
          `@@ -0,0 +1,${content.split('\n').length} @@`,
          ...content.split('\n').map((line) => `+${line}`),
        ].join('\n');
      }
      this.post({
        type: 'diffPreview',
        path: filePath,
        staged,
        conflicted: change.conflicted,
        diff,
      });
    } catch (error) {
      this.reportError('Unable to preview change', error);
    }
  }

  private async commit(message: string, amend: boolean): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) {
      void vscode.window.showWarningMessage('Enter a commit message first.');
      return;
    }
    await this.execute('Creating commit', (repo) => repo.commit(trimmed, amend), 'Commit created');
  }

  private async promptCommit(): Promise<void> {
    if (!this.state.status?.changes.some((change) => change.hasStagedChange)) {
      void vscode.window.showInformationMessage('Stage one or more changes before committing.');
      return;
    }
    const message = await vscode.window.showInputBox({
      title: 'Commit Staged Changes',
      prompt: 'Commit message',
      placeHolder: 'Describe the changes',
      validateInput: (value) => value.trim() ? undefined : 'A commit message is required',
    });
    if (message !== undefined) {
      await this.commit(message, false);
    }
  }

  private async push(): Promise<void> {
    const repository = this.activeRepository;
    if (!repository) {
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'VC Smart Git: Pushing' }, () => repository.push());
      this.post({ type: 'toast', message: 'Push complete' });
      await this.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/no upstream branch|set-upstream/i.test(text) && this.state.status?.branch && this.state.status.branch !== '(detached)') {
        const answer = await vscode.window.showInformationMessage(
          `Branch “${this.state.status.branch}” has no upstream. Publish it to origin?`,
          'Publish Branch',
        );
        if (answer === 'Publish Branch') {
          await this.execute('Publishing branch', (repo) => repo.publish(this.state.status?.branch ?? ''), 'Branch published');
        }
      } else {
        this.reportError('Push failed', error);
      }
    }
  }

  private async switchBranch(branch: string | undefined): Promise<void> {
    if (!branch || !this.state.branches.some((entry) => !entry.remote && entry.name === branch)) {
      return;
    }
    await this.execute(`Switching to ${branch}`, (repo) => repo.switchBranch(branch));
  }

  private async newBranch(startPoint?: string): Promise<void> {
    const knownRef = startPoint && (
      this.validHash(startPoint)
      || this.state.branches.some((branch) => branch.name === startPoint)
    );
    if (startPoint && !knownRef) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: startPoint ? 'Create Branch from Selected Revision' : 'Create Branch',
      prompt: 'New branch name',
      placeHolder: 'feature/my-change',
      validateInput: (value) => value.trim() ? undefined : 'A branch name is required',
    });
    if (!name?.trim()) {
      return;
    }
    await this.execute(`Creating branch ${name.trim()}`, (repo) => repo.createBranch(name.trim(), startPoint));
  }

  private async copyBranchName(branch: string | undefined): Promise<void> {
    if (!branch || !this.state.branches.some((entry) => entry.name === branch)) {
      return;
    }
    await vscode.env.clipboard.writeText(branch);
    this.post({ type: 'toast', message: 'Branch name copied' });
  }

  private async createTag(hash: string | undefined): Promise<void> {
    if (!this.validHash(hash)) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Create Tag from Commit',
      prompt: `Tag ${hash.slice(0, 8)}`,
      placeHolder: 'v1.0.0',
      validateInput: (value) => value.trim() ? undefined : 'A tag name is required',
    });
    if (name?.trim()) {
      await this.execute(`Creating tag ${name.trim()}`, (repo) => repo.createTag(name.trim(), hash));
    }
  }

  private async compareWithLocal(hash: string | undefined): Promise<void> {
    if (!this.validHash(hash) || !this.activeRepository) {
      return;
    }
    try {
      const files = await this.activeRepository.filesAgainst(hash);
      if (files.length === 0) {
        void vscode.window.showInformationMessage(`Local files match ${hash.slice(0, 8)}.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        files.map((file) => ({ label: file.path, description: file.status, file })),
        { title: `Compare ${hash.slice(0, 8)} with Local`, placeHolder: 'Choose a changed file' },
      );
      if (!picked) {
        return;
      }
      const beforePath = picked.file.originalPath ?? picked.file.path;
      const before = await this.activeRepository.readCommitBlob(hash, beforePath);
      const left = this.contentProvider.create(before, beforePath, hash.slice(0, 8));
      const localUri = vscode.Uri.file(resolveRepositoryPath(this.activeRepository.root, picked.file.path));
      let right = localUri;
      try {
        await vscode.workspace.fs.stat(localUri);
      } catch {
        right = this.contentProvider.create('', picked.file.path, 'Deleted');
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.basename(picked.file.path)} (${hash.slice(0, 8)} ↔ Local)`,
        { preview: false },
      );
    } catch (error) {
      this.reportError('Unable to compare commit with local files', error);
    }
  }

  private async resetToCommit(hash: string | undefined): Promise<void> {
    if (!this.validHash(hash)) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Reset the current branch to ${hash.slice(0, 8)}? All tracked staged and working-tree changes will be discarded.`,
      { modal: true },
      'Reset Branch',
    );
    if (answer === 'Reset Branch') {
      await this.execute(`Resetting branch to ${hash.slice(0, 8)}`, (repo) => repo.resetHard(hash));
    }
  }

  private async deleteBranch(branch: string | undefined): Promise<void> {
    let entry = this.state.branches.find((candidate) => !candidate.remote && candidate.name === branch);
    if (!entry) {
      const candidates = this.state.branches.filter((candidate) => !candidate.remote && !candidate.current);
      const picked = await vscode.window.showQuickPick(
        candidates.map((candidate) => ({ label: candidate.name, description: candidate.tracking, branch: candidate })),
        { title: 'Delete Local Branch', placeHolder: 'Choose a fully merged local branch' },
      );
      entry = picked?.branch;
      branch = entry?.name;
    }
    if (!branch || !entry) {
      return;
    }
    if (entry.current) {
      void vscode.window.showWarningMessage('The current branch cannot be deleted. Switch branches first.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(`Delete local branch “${branch}”?`, { modal: true }, 'Delete Branch');
    if (answer === 'Delete Branch') {
      await this.execute(`Deleting branch ${branch}`, (repo) => repo.deleteBranch(branch));
    }
  }

  private async showCommit(hash: string | undefined): Promise<void> {
    if (!this.validHash(hash) || !this.activeRepository) {
      return;
    }
    try {
      const [details, files] = await Promise.all([
        this.activeRepository.commitDetails(hash),
        this.activeRepository.commitFiles(hash),
      ]);
      const commit = this.state.commits.find((entry) => entry.hash === hash);
      this.post({
        type: 'commitDetails',
        hash,
        title: commit?.subject ?? hash,
        details,
        files,
        fileIcons: this.fileIcons(files.map((file) => file.path)),
      });
    } catch (error) {
      this.reportError('Unable to load commit details', error);
    }
  }

  private async openCommitDiff(
    hash: string | undefined,
    filePath: string | undefined,
    originalPath: string | undefined,
  ): Promise<void> {
    if (!this.validHash(hash) || !filePath || !this.activeRepository) {
      return;
    }
    const knownCommit = this.state.commits.find((commit) => commit.hash === hash);
    if (!knownCommit) {
      return;
    }
    const parent = knownCommit.parents[0];
    const beforePath = originalPath ?? filePath;
    const [before, after] = await Promise.all([
      parent ? this.activeRepository.readCommitBlob(parent, beforePath) : Promise.resolve(''),
      this.activeRepository.readCommitBlob(hash, filePath),
    ]);
    const left = this.contentProvider.create(before, beforePath, parent ? parent.slice(0, 8) : 'Empty');
    const right = this.contentProvider.create(after, filePath, hash.slice(0, 8));
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${path.basename(filePath)} (${hash.slice(0, 8)})`,
      { preview: true },
    );
  }

  private async checkoutCommit(hash: string | undefined): Promise<void> {
    if (!this.validHash(hash)) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Check out ${hash.slice(0, 8)} in detached HEAD mode?`,
      { modal: true },
      'Checkout Commit',
    );
    if (answer === 'Checkout Commit') {
      await this.execute(`Checking out ${hash.slice(0, 8)}`, (repo) => repo.switchDetached(hash));
    }
  }

  private async commitAction(
    label: string,
    hash: string | undefined,
    action: (repository: GitRepository, hash: string) => Promise<void>,
  ): Promise<void> {
    if (!this.validHash(hash)) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(`${label} commit ${hash.slice(0, 8)}?`, { modal: true }, label);
    if (answer === label) {
      await this.execute(`${label} ${hash.slice(0, 8)}`, (repo) => action(repo, hash));
    }
  }

  private async copyHash(hash: string | undefined): Promise<void> {
    if (this.validHash(hash)) {
      await vscode.env.clipboard.writeText(hash);
      this.post({ type: 'toast', message: 'Commit hash copied' });
    }
  }

  private async continueOperation(): Promise<void> {
    const operation = this.state.operation;
    if (operation) {
      await this.execute(`Continuing ${operation}`, (repo) => repo.continueOperation(operation), `${operation} continued`);
    }
  }

  private async abortOperation(): Promise<void> {
    const operation = this.state.operation;
    if (!operation) {
      return;
    }
    const confirm = vscode.workspace.getConfiguration('vcSmartGit').get('confirmDestructiveActions', true);
    if (confirm) {
      const answer = await vscode.window.showWarningMessage(`Abort the current ${operation}?`, { modal: true }, `Abort ${operation}`);
      if (answer !== `Abort ${operation}`) {
        return;
      }
    }
    await this.execute(`Aborting ${operation}`, (repo) => repo.abortOperation(operation), `${operation} aborted`);
  }

  private async execute(
    title: string,
    action: (repository: GitRepository) => Promise<void>,
    successMessage?: string,
  ): Promise<boolean> {
    const repository = this.activeRepository;
    if (!repository) {
      void vscode.window.showWarningMessage('No Git repository is selected.');
      return false;
    }
    try {
      this.postConsole('command', title);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `VC Smart Git: ${title}` },
        () => action(repository),
      );
      if (successMessage) {
        this.post({ type: 'toast', message: successMessage });
      }
      this.postConsole('success', successMessage ?? `${title} complete`);
      await this.refresh();
      return true;
    } catch (error) {
      this.reportError(`${title} failed`, error);
      await this.refresh();
      return false;
    }
  }

  private reportError(context: string, error: unknown): void {
    const detail = error instanceof GitCommandError
      ? error.stderr.trim() || error.message
      : error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[${new Date().toISOString()}] ${context}`);
    this.output.appendLine(detail);
    this.postConsole('error', `${context}: ${detail}`);
    void vscode.window.showErrorMessage(`${context}: ${detail}`, 'Show Git Output').then((answer) => {
      if (answer === 'Show Git Output') {
        this.output.show(true);
      }
    });
  }

  private postConsole(level: 'command' | 'success' | 'error', message: string): void {
    this.post({ type: 'consoleEntry', level, message, timestamp: new Date().toISOString() });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }
}
