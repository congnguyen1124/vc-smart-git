import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitBlameLine } from '../git/blame';
import { GitRepository } from '../git/repository';

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

function hoverFor(line: GitBlameLine): vscode.MarkdownString {
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
  hover.isTrusted = false;
  return hover;
}

export class GitBlameController implements vscode.Disposable {
  private readonly enabledDocuments = new Set<string>();
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

  public constructor(private readonly output: vscode.LogOutputChannel) {
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
      vscode.workspace.onDidCloseTextDocument((document) => {
        const key = documentKey(document);
        this.enabledDocuments.delete(key);
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
    this.cancelRefresh(key);
    this.requestVersions.set(key, (this.requestVersions.get(key) ?? 0) + 1);
    editor.setDecorations(this.decorationType, []);
    await this.updateContext(editor);
  }

  public dispose(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
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
    const decorations = lines
      .filter((line) => line.finalLine > 0 && line.finalLine <= document.lineCount)
      .map((line): vscode.DecorationOptions => ({
        range: new vscode.Range(line.finalLine - 1, 0, line.finalLine - 1, 0),
        hoverMessage: hoverFor(line),
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
  }

  private async updateContext(editor: vscode.TextEditor | undefined): Promise<void> {
    const visible = Boolean(editor && this.enabledDocuments.has(documentKey(editor.document)));
    await vscode.commands.executeCommand('setContext', 'vcSmartGit.blameVisible', visible);
  }
}
