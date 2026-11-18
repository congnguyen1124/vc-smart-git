import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitBlameLine } from '../git/blame';
import { GitRepository } from '../git/repository';
import { GitContentProvider } from './diffProvider';

interface BlameDocumentState {
  root: string;
  filePath: string;
  lines: Map<number, GitBlameLine>;
}

interface BlameCommandArgument {
  documentUri: string;
  line: number;
  hash: string;
}

export interface GitBlameTarget {
  root: string;
  filePath: string;
  line: GitBlameLine;
}

function documentKey(document: vscode.TextDocument): string {
  return document.uri.toString();
}

function compactAuthor(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  const value = parts.at(-1) ?? (author.trim() || 'Unknown');
  return value.length > 14 ? `${value.slice(0, 13)}…` : value;
}

function compactDate(timestamp: number): string {
  if (!timestamp) {
    return 'local';
  }
  const date = new Date(timestamp * 1000);
  const year = String(date.getFullYear()).slice(-2);
  return `${date.getMonth() + 1}/${date.getDate()}/${year}`;
}

function annotationText(line: GitBlameLine): string {
  if (line.uncommitted) {
    return 'Local changes';
  }
  return `${compactDate(line.authorTime)}  ${compactAuthor(line.author)}`;
}

function commandUri(command: string, argument: BlameCommandArgument): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([argument]))}`;
}

function hoverFor(line: GitBlameLine, argument: BlameCommandArgument): vscode.MarkdownString {
  const hover = new vscode.MarkdownString(undefined, true);
  hover.appendMarkdown('**Git Blame**  \n');
  hover.appendMarkdown('**Author:** ');
  hover.appendText(line.author);
  if (line.authorEmail) {
    hover.appendText(` <${line.authorEmail}>`);
  }
  hover.appendMarkdown('  \n**Commit:** ');
  hover.appendText(line.uncommitted ? 'Local changes' : line.hash);
  if (line.authorTime) {
    hover.appendMarkdown('  \n**Date:** ');
    hover.appendText(new Date(line.authorTime * 1000).toLocaleString());
  }
  if (line.summary) {
    hover.appendMarkdown('  \n**Message:** ');
    hover.appendText(line.summary);
  }
  if (!line.uncommitted) {
    hover.appendMarkdown(`  \n\n[Show in VC Smart Git Log](${commandUri('vcSmartGit.showBlameCommit', argument)})`);
    hover.appendMarkdown(` · [Show Diff](${commandUri('vcSmartGit.showBlameDiff', argument)})`);
  }
  hover.isTrusted = {
    enabledCommands: ['vcSmartGit.showBlameCommit', 'vcSmartGit.showBlameDiff'],
  };
  return hover;
}

function isBlameCommandArgument(value: unknown): value is BlameCommandArgument {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<BlameCommandArgument>;
  return typeof candidate.documentUri === 'string'
    && Number.isInteger(candidate.line)
    && typeof candidate.hash === 'string';
}

function remoteFileUrl(remote: string, hash: string, filePath: string): vscode.Uri | undefined {
  let repositoryUrl = remote.trim();
  const scp = /^git@([^:]+):(.+)$/.exec(repositoryUrl);
  if (scp) {
    repositoryUrl = `https://${scp[1]}/${scp[2]}`;
  } else if (repositoryUrl.startsWith('ssh://')) {
    try {
      const ssh = new URL(repositoryUrl);
      repositoryUrl = `https://${ssh.hostname}${ssh.pathname}`;
    } catch {
      return undefined;
    }
  }
  repositoryUrl = repositoryUrl.replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(repositoryUrl)) {
    return undefined;
  }
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const host = new URL(repositoryUrl).hostname.toLowerCase();
  if (host.includes('gitlab')) {
    return vscode.Uri.parse(`${repositoryUrl}/-/blob/${hash}/${encodedPath}`);
  }
  if (host.includes('bitbucket')) {
    return vscode.Uri.parse(`${repositoryUrl}/src/${hash}/${encodedPath}`);
  }
  if (host.includes('dev.azure.com') || host.endsWith('visualstudio.com')) {
    return vscode.Uri.parse(`${repositoryUrl}?path=/${encodedPath}&version=GC${hash}`);
  }
  return vscode.Uri.parse(`${repositoryUrl}/blob/${hash}/${encodedPath}`);
}

export class GitBlameController implements vscode.Disposable {
  private readonly enabledDocuments = new Set<string>();
  private readonly documents = new Map<string, BlameDocumentState>();
  private readonly requestVersions = new Map<string, number>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      width: '12em',
      margin: '0 1.25em 0 0',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
      fontStyle: 'normal',
      fontWeight: 'normal',
    },
  });

  public constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly contentProvider: GitContentProvider,
    private readonly revealCommit: (target: GitBlameTarget) => Promise<void>,
  ) {
    this.subscriptions.push(
      this.decorationType,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.updateContext(editor);
        if (editor && this.enabledDocuments.has(documentKey(editor.document))) {
          this.refreshQuietly(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          if (this.enabledDocuments.has(documentKey(editor.document))) {
            this.refreshQuietly(editor);
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.enabledDocuments.has(documentKey(event.document))) {
          this.scheduleRefresh(event.document, 350);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.enabledDocuments.has(documentKey(document))) {
          this.scheduleRefresh(document, 0);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        void this.updateContext(event.textEditor);
        const selection = event.selections[0];
        if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse
          || !selection?.isEmpty
          || selection.active.character !== 0) {
          return;
        }
        const target = this.targetAt(event.textEditor, selection.active.line + 1);
        if (target && !target.line.uncommitted) {
          void this.revealCommit(target).catch((error: unknown) => {
            this.reportActionError('Unable to show the blamed commit', error);
          });
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const key = documentKey(document);
        this.enabledDocuments.delete(key);
        this.documents.delete(key);
        this.cancelRefresh(key);
        void this.updateContext(vscode.window.activeTextEditor);
      }),
    );
    void this.updateContext(vscode.window.activeTextEditor);
  }

  public async annotateActive(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a file from a Git repository before enabling Git Blame annotations.');
      return;
    }
    const key = documentKey(editor.document);
    this.enabledDocuments.add(key);
    await this.updateContext(editor);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Loading Git Blame…' },
      async () => {
        try {
          await this.refresh(editor);
        } catch (error) {
          this.enabledDocuments.delete(key);
          this.documents.delete(key);
          editor.setDecorations(this.decorationType, []);
          await this.updateContext(editor);
          const detail = error instanceof Error ? error.message : String(error);
          this.output.error(`Unable to annotate ${editor.document.uri.fsPath}: ${detail}`);
          void vscode.window.showWarningMessage(`Git Blame is unavailable for this file: ${detail}`);
        }
      },
    );
  }

  public async hideActive(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const key = documentKey(editor.document);
    this.enabledDocuments.delete(key);
    this.documents.delete(key);
    this.cancelRefresh(key);
    this.requestVersions.set(key, (this.requestVersions.get(key) ?? 0) + 1);
    editor.setDecorations(this.decorationType, []);
    await this.updateContext(editor);
  }

  public async showCommit(argument?: unknown): Promise<void> {
    const target = this.resolveTarget(argument);
    if (!target || target.line.uncommitted) {
      void vscode.window.showInformationMessage('Select a committed Git Blame line first.');
      return;
    }
    await this.revealCommit(target);
  }

  public async showDiff(argument?: unknown): Promise<void> {
    const target = this.resolveTarget(argument);
    if (!target || target.line.uncommitted) {
      void vscode.window.showInformationMessage('Select a committed Git Blame line first.');
      return;
    }
    try {
      const repository = this.repositoryFor(target.root);
      const commit = await repository.commitByHash(target.line.hash);
      if (!commit) {
        throw new Error(`commit ${target.line.hash.slice(0, 8)} was not found`);
      }
      const historicalPath = target.line.filePath || target.filePath;
      const parent = commit.parents[0];
      const [before, after] = await Promise.all([
        parent ? repository.readCommitBlob(parent, historicalPath) : Promise.resolve(''),
        repository.readCommitBlob(commit.hash, historicalPath),
      ]);
      const left = this.contentProvider.create(before, historicalPath, parent?.slice(0, 8) ?? 'Empty');
      const right = this.contentProvider.create(after, historicalPath, commit.shortHash);
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.basename(historicalPath)} (${commit.shortHash})`,
        { preview: true },
      );
    } catch (error) {
      this.reportActionError('Unable to show the blamed revision diff', error);
    }
  }

  public async copyRevision(argument?: unknown): Promise<void> {
    const target = this.resolveTarget(argument);
    if (!target || target.line.uncommitted) {
      void vscode.window.showInformationMessage('Select a committed Git Blame line first.');
      return;
    }
    await vscode.env.clipboard.writeText(target.line.hash);
    void vscode.window.showInformationMessage(`Copied revision ${target.line.hash.slice(0, 8)}.`);
  }

  public async openRevision(argument?: unknown, previous = false): Promise<void> {
    const target = this.resolveTarget(argument);
    if (!target || target.line.uncommitted) {
      void vscode.window.showInformationMessage('Select a committed Git Blame line first.');
      return;
    }
    try {
      const repository = this.repositoryFor(target.root);
      const commit = await repository.commitByHash(target.line.hash);
      const revision = previous ? commit?.parents[0] : commit?.hash;
      if (!commit || !revision) {
        void vscode.window.showInformationMessage(previous
          ? 'This is the first revision; there is no previous revision to open.'
          : 'The selected revision is unavailable.');
        return;
      }
      const historicalPath = target.line.filePath || target.filePath;
      const contents = await repository.readCommitBlob(revision, historicalPath);
      const uri = this.contentProvider.create(contents, historicalPath, revision.slice(0, 8));
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (error) {
      this.reportActionError('Unable to open the blamed revision', error);
    }
  }

  public async viewInBrowser(argument?: unknown): Promise<void> {
    const target = this.resolveTarget(argument);
    if (!target || target.line.uncommitted) {
      void vscode.window.showInformationMessage('Select a committed Git Blame line first.');
      return;
    }
    try {
      const remote = await this.repositoryFor(target.root).remoteUrl();
      const uri = remote && remoteFileUrl(remote, target.line.hash, target.line.filePath || target.filePath);
      if (!uri) {
        void vscode.window.showInformationMessage('The origin remote does not expose a supported web URL.');
        return;
      }
      await vscode.env.openExternal(uri);
    } catch (error) {
      this.reportActionError('Unable to open the blamed revision in a browser', error);
    }
  }

  public dispose(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.documents.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private repositoryFor(root: string): GitRepository {
    const gitPath = vscode.workspace.getConfiguration('vcSmartGit').get('gitPath', 'git');
    return new GitRepository(root, gitPath);
  }

  private resolveTarget(argument: unknown): GitBlameTarget | undefined {
    if (isBlameCommandArgument(argument)) {
      const state = this.documents.get(argument.documentUri);
      const line = state?.lines.get(argument.line);
      if (state && line && line.hash === argument.hash) {
        return { root: state.root, filePath: state.filePath, line };
      }
    }
    const editor = vscode.window.activeTextEditor;
    return editor ? this.targetAt(editor, editor.selection.active.line + 1) : undefined;
  }

  private targetAt(editor: vscode.TextEditor, oneBasedLine: number): GitBlameTarget | undefined {
    const state = this.documents.get(documentKey(editor.document));
    const line = state?.lines.get(oneBasedLine);
    return state && line ? { root: state.root, filePath: state.filePath, line } : undefined;
  }

  private reportActionError(context: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.output.error(`${context}: ${detail}`);
    void vscode.window.showWarningMessage(`${context}: ${detail}`);
  }

  private scheduleRefresh(document: vscode.TextDocument, delay: number): void {
    const key = documentKey(document);
    this.cancelRefresh(key);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(key);
      for (const editor of vscode.window.visibleTextEditors) {
        if (documentKey(editor.document) === key) {
          void this.refresh(editor).catch((error: unknown) => {
            this.output.warn(`Unable to refresh Git Blame: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
    }, delay);
    this.refreshTimers.set(key, timer);
  }

  private cancelRefresh(key: string): void {
    const timer = this.refreshTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(key);
    }
  }

  private refreshQuietly(editor: vscode.TextEditor): void {
    void this.refresh(editor).catch((error: unknown) => {
      this.output.warn(`Unable to refresh Git Blame: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async refresh(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const key = documentKey(document);
    if (!this.enabledDocuments.has(key) || document.uri.scheme !== 'file') {
      return;
    }
    const version = (this.requestVersions.get(key) ?? 0) + 1;
    this.requestVersions.set(key, version);

    const gitPath = vscode.workspace.getConfiguration('vcSmartGit').get('gitPath', 'git');
    const probe = new GitRepository(path.dirname(document.uri.fsPath), gitPath);
    const rootResult = await probe.run(['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (rootResult.exitCode !== 0) {
      throw new Error('the active file is not inside a Git repository');
    }
    const root = rootResult.stdout.trim();
    const relativePath = path.relative(root, document.uri.fsPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('the active file is outside the detected Git repository');
    }
    const repository = new GitRepository(root, gitPath);
    const lines = await repository.blame(relativePath, document.getText());
    if (this.requestVersions.get(key) !== version || !this.enabledDocuments.has(key)) {
      return;
    }
    this.documents.set(key, {
      root,
      filePath: relativePath,
      lines: new Map(lines.map((line) => [line.finalLine, line])),
    });
    const decorations = lines
      .filter((line) => line.finalLine > 0 && line.finalLine <= document.lineCount)
      .map((line): vscode.DecorationOptions => ({
        range: new vscode.Range(line.finalLine - 1, 0, line.finalLine - 1, 0),
        hoverMessage: hoverFor(line, {
          documentUri: key,
          line: line.finalLine,
          hash: line.hash,
        }),
        renderOptions: {
          before: {
            contentText: annotationText(line),
            backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
            color: line.uncommitted
              ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
              : new vscode.ThemeColor('editorCodeLens.foreground'),
          },
        },
      }));
    editor.setDecorations(this.decorationType, decorations);
    await this.updateContext(editor);
  }

  private async updateContext(editor: vscode.TextEditor | undefined): Promise<void> {
    const visible = Boolean(editor && this.enabledDocuments.has(documentKey(editor.document)));
    const target = editor ? this.targetAt(editor, editor.selection.active.line + 1) : undefined;
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'vcSmartGit.blameVisible', visible),
      vscode.commands.executeCommand(
        'setContext',
        'vcSmartGit.blameCommittedLine',
        Boolean(visible && target && !target.line.uncommitted),
      ),
    ]);
  }
}
