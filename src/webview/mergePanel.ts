import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { acceptMergeSide, applyMergeResult, loadMergeSnapshot, MergeStageError, type MergeSnapshot } from '../git/merge';
import type { GitRepository } from '../git/repository';
import type { GitConflictState } from '../git/types';
import { resolveRepositoryPath } from '../vscode/diffProvider';

function mergeHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomUUID();
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).with({ query: nonce });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${asset('merge.css')}">
  <title>Smart Git Merge</title>
</head>
<body>
  <header class="masthead">
    <div class="title-group">
      <h1 id="fileName">Merge conflict</h1>
      <div id="fileLocation" class="muted"></div>
    </div>
    <span id="progress" class="status" role="status">Loading conflict…</span>
  </header>
  <div id="toolbar" class="toolbar hidden">
    <div class="navigation">
      <button id="previous" type="button" aria-label="Previous conflict" title="Previous conflict">↑</button>
      <button id="next" type="button" aria-label="Next conflict" title="Next conflict">↓</button>
      <span id="position" class="muted"></span>
      <button id="resolveSimple" type="button" disabled>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <path d="M2 12.8l8-8 2 2-8 8zM8 7l2 2M4 1.5v4m-2-2h4m7-2v4m-2-2h4m-2 7v4m-2-2h4" />
        </svg>
        Resolve Simple Conflicts
      </button>
    </div>
    <ul class="diff-legend" aria-label="Change colors">
      <li class="diff-added">Added</li>
      <li class="diff-removed">Removed</li>
      <li class="diff-modified">Replaced</li>
    </ul>
    <div class="view-tools">
      <button id="toggleRevision" type="button" aria-pressed="false">Full revisions</button>
      <button id="toggleBase" type="button" aria-pressed="false">Show base</button>
    </div>
  </div>
  <div id="error" class="notice hidden" role="alert"></div>
  <main id="mergeEditor" class="merge-grid hidden" aria-label="Three-way merge">
    <section class="pane pane-ours" aria-label="Current side">
      <header class="pane-heading"><span class="pane-dot"></span><div><strong id="oursName">Ours</strong><span id="oursMeta" class="muted"></span></div></header>
      <div id="oursCode" class="code-scroll" tabindex="0"></div>
      <footer class="pane-actions">
        <button id="useOurs" type="button">Use Current →</button>
        <button id="acceptOurs" type="button">Entire Current…</button>
      </footer>
    </section>
    <section class="pane pane-result" aria-label="Merge result">
      <header class="pane-heading"><span class="pane-dot"></span><div><strong>Result</strong><span id="resultMeta" class="muted">Editable working copy</span></div></header>
      <div id="editorBody" class="editor-body">
        <div id="gutter" class="gutter" aria-hidden="true"></div>
        <div id="resultHighlights" class="result-highlights" aria-hidden="true"></div>
        <textarea id="result" aria-label="Editable merge result" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      </div>
      <p id="resultNote" class="muted empty hidden"></p>
      <footer class="pane-actions result-actions">
        <button id="useBase" type="button" class="hidden">Use Base</button>
        <button id="useBoth" type="button">Use Both</button>
        <button id="undoChoice" type="button">Undo choice</button>
      </footer>
    </section>
    <section class="pane pane-theirs" aria-label="Incoming side">
      <header class="pane-heading"><span class="pane-dot"></span><div><strong>Incoming</strong><span id="theirsMeta" class="muted"></span></div></header>
      <div id="theirsCode" class="code-scroll" tabindex="0"></div>
      <footer class="pane-actions">
        <button id="useTheirs" type="button">← Use Incoming</button>
        <button id="acceptTheirs" type="button">Entire Incoming…</button>
      </footer>
    </section>
  </main>
  <footer class="page-footer">
    <div id="footerHelp" class="muted" role="status">Loading revisions from Git…</div>
    <div class="footer-actions">
      <button id="close" type="button">Close</button>
      <button id="apply" class="primary" type="button" disabled>Apply &amp; Stage</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${asset('mergeModel.js')}"></script>
  <script nonce="${nonce}" src="${asset('merge.js')}"></script>
</body>
</html>`;
}

export class MergePanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly resolved: () => Promise<void>,
  ) {}

  public open(repo: GitRepository, filePath: string, conflict?: GitConflictState): void {
    const key = JSON.stringify([repo.root, filePath]);
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'vcSmartGit.merge',
      `Merge: ${path.basename(filePath)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panels.set(key, panel);
    let disposed = false;
    let busy = false;
    let snapshot: MergeSnapshot | undefined;
    const post = (message: unknown): void => {
      if (!disposed) void panel.webview.postMessage(message);
    };
    const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || disposed || busy) return;
      const { type, text, side, dirty } = message as Record<string, unknown>;
      busy = true;
      try {
        if (type === 'ready') {
          snapshot = await loadMergeSnapshot(repo, filePath);
          post({
            type: 'file', path: filePath, repository: path.basename(repo.root),
            oursLabel: conflict?.currentBranch,
            theirsLabel: conflict?.incomingLabel,
            operation: conflict?.operation,
            markerSize: snapshot.markerSize,
            working: { text: snapshot.working.text, note: snapshot.working.note },
            base: snapshot.base, ours: snapshot.ours, theirs: snapshot.theirs,
            conflictBases: snapshot.conflictBases,
          });
        } else if (type === 'close') {
          if (dirty === true) {
            const choice = await vscode.window.showWarningMessage(
              'Discard the edits in this merge tab?',
              { modal: true },
              'Discard Draft',
            );
            if (choice !== 'Discard Draft') return;
          }
          panel.dispose();
        } else if (snapshot && (type === 'apply' || type === 'acceptSide')) {
          if (type === 'apply' && typeof text !== 'string') return;
          if (type === 'acceptSide' && side !== 'ours' && side !== 'theirs') return;
          const absolute = resolveRepositoryPath(repo.root, filePath);
          const hasUnsavedEdits = () => vscode.workspace.textDocuments.some(
            (document) => document.uri.scheme === 'file' && document.uri.fsPath === absolute && document.isDirty,
          );
          if (hasUnsavedEdits()) throw new Error('Save or discard the unsaved changes in the text editor first.');
          if (type === 'apply' && typeof text === 'string') {
            await applyMergeResult(repo, snapshot, text);
          } else if (side === 'ours' || side === 'theirs') {
            const label = side === 'ours' ? 'Current' : 'Incoming';
            const action = snapshot[side].present ? `Accept ${label}` : 'Accept Deletion';
            const prompt = snapshot[side].present
              ? `Replace “${path.basename(filePath)}” with the entire ${label.toLowerCase()} revision and stage it?`
              : `Accept the deletion of “${path.basename(filePath)}” and stage it?`;
            const choice = await vscode.window.showWarningMessage(prompt, { modal: true }, action);
            if (disposed || choice !== action) return;
            if (hasUnsavedEdits()) throw new Error('Save or discard the unsaved changes in the text editor first.');
            await acceptMergeSide(repo, snapshot, side);
          }
          await this.resolved();
          if (!disposed) panel.dispose();
        }
      } catch (error) {
        if (error instanceof MergeStageError) {
          snapshot = await loadMergeSnapshot(repo, filePath).catch(() => snapshot);
        }
        post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        busy = false;
        post({ type: 'idle' });
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      listener.dispose();
      this.panels.delete(key);
    });
    panel.webview.html = mergeHtml(panel.webview, this.extensionUri);
  }

  public dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
  }
}
