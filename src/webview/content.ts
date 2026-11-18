import * as vscode from 'vscode';

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

export function webviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const token = nonce();
  const cacheKey = `v=${token}`;
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css')).with({ query: cacheKey });
  const graphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logGraph.js')).with({ query: cacheKey });
  const selectionScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'changeSelection.js')).with({ query: cacheKey });
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js')).with({ query: cacheKey });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${token}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>VC Smart Git</title>
</head>
<body>
  <div id="loading" class="loading"><span class="spinner"></span><span>Loading repository…</span></div>
  <main id="app" class="hidden">
    <header class="tool-header" data-context="repository">
      <strong class="product-title">Git</strong>
      <nav class="tabs" role="tablist" aria-label="Git tool window tabs">
        <button id="changesTabButton" class="tab active" role="tab" data-tab="changes">Local Changes <span id="changeCount" class="count"></span></button>
        <button id="logTabButton" class="tab" role="tab" data-tab="log">Log</button>
        <button id="consoleTabButton" class="tab" role="tab" data-tab="console">Console</button>
      </nav>
      <span class="spacer"></span>
      <select id="repository" aria-label="Repository"></select>
      <span id="branchBadge" class="branch-badge" title="Current branch"></span>
      <button class="icon-button" data-action="refresh" title="Refresh">↻</button>
      <button class="icon-button menu-trigger" data-context-trigger="repository" title="Git actions" aria-label="Git actions">⋮</button>
    </header>

    <section id="operationBanner" class="operation-banner hidden">
      <span id="operationText"></span>
      <span class="spacer"></span>
      <button data-action="continueOperation">Continue</button>
      <button class="danger" data-action="abortOperation">Abort</button>
    </section>

    <section id="changesTab" class="tab-page changes-workspace">
      <aside class="changes-pane">
        <div id="changeTree" class="change-tree" data-context="changesRoot">
          <div id="changesGroup"></div>
          <div id="unversionedGroup"></div>
          <div id="cleanState" class="empty hidden">
            <div class="empty-icon">✓</div>
            <div>Working tree is clean</div>
          </div>
        </div>
      </aside>

      <section id="diffPane" class="diff-pane">
        <div id="diffToolbar" class="pane-toolbar diff-toolbar" data-context="change">
          <button class="icon-button" data-action="previousChange" title="Previous change">↑</button>
          <button class="icon-button" data-action="nextChange" title="Next change">↓</button>
          <button class="icon-button" data-action="openSelectedDiff" title="Open in VS Code Diff Editor">↗</button>
          <span class="toolbar-separator"></span>
          <button class="file-counter" data-action="openSelectedDiff" title="Open selected file in VS Code Diff Editor"><span id="diffFileCounter">0/0 files</span> →</button>
          <span class="spacer"></span>
          <span id="diffStats" class="diff-stats"></span>
          <span class="toolbar-separator"></span>
          <button id="stageSelected" class="icon-button hidden" data-action="stageSelected" title="Stage selected files">＋</button>
          <button id="unstageSelected" class="icon-button hidden" data-action="unstageSelected" title="Unstage selected files">−</button>
          <button id="discardSelected" class="icon-button danger hidden" data-action="discardSelected" title="Rollback selected files">↶</button>
          <button id="toggleDiffExpanded" class="icon-button" data-action="toggleDiffExpanded" title="Maximize diff preview">⛶</button>
          <button id="diffMenu" class="icon-button menu-trigger hidden" data-context-trigger="change" title="File actions" aria-label="File actions">⋮</button>
        </div>
        <div id="diffMeta" class="diff-meta">
          <div class="diff-file-line"><strong id="diffFileName">Select a changed file</strong><span id="diffFilePath"></span></div>
          <div id="diffRevision" class="diff-revision">Choose a file on the left to preview its changes.</div>
        </div>
        <div id="diffBody" class="diff-body" aria-label="Diff preview"></div>
      </section>
    </section>

    <section id="logTab" class="tab-page log-workspace hidden">
      <aside class="branches-pane">
        <div class="pane-toolbar">
          <input id="branchFilter" class="filter" type="search" placeholder="Branch or tag">
        </div>
        <div id="branchTree" class="branch-tree"></div>
      </aside>

      <section class="history-pane">
        <div class="pane-toolbar history-toolbar">
          <input id="logFilter" class="filter" type="search" placeholder="Text or hash">
          <span class="filter-chip">Branch<span class="chevron-icon" aria-hidden="true"></span></span>
          <span class="filter-chip">User<span class="chevron-icon" aria-hidden="true"></span></span>
          <span class="filter-chip">Date<span class="chevron-icon" aria-hidden="true"></span></span>
          <span class="filter-chip">Paths<span class="chevron-icon" aria-hidden="true"></span></span>
          <span class="spacer"></span>
          <button class="icon-button" data-action="refresh" title="Refresh log">↻</button>
        </div>
        <div class="log-columns" aria-hidden="true"><span>Graph &amp; Subject</span><span>Refs</span><span>Author</span><span>Date</span></div>
        <div id="logList" class="log-list" role="list"></div>
      </section>

      <aside class="commit-pane">
        <div class="pane-toolbar">
          <strong>Commit</strong>
        </div>
        <div id="commitEmpty" class="empty compact">Select a commit to inspect its files and details.</div>
        <div id="commitDetails" class="commit-details hidden">
          <div id="commitFileTree" class="commit-file-tree"></div>
          <div class="details-summary">
            <div class="details-header">
              <strong id="detailsTitle"></strong>
            </div>
            <pre id="detailsBody"></pre>
          </div>
        </div>
      </aside>
    </section>

    <section id="consoleTab" class="tab-page console-workspace hidden">
      <div class="pane-toolbar">
        <strong>Git Console</strong>
        <span class="spacer"></span>
        <button data-action="clearConsole">Clear</button>
      </div>
      <div id="consoleList" class="console-list" role="log" aria-live="polite"></div>
    </section>
  </main>

  <section id="noRepository" class="empty page-empty hidden">
    <div class="empty-icon">⑂</div>
    <h3>No Git repository</h3>
    <p>Open a folder containing a Git repository to use VC Smart Git.</p>
    <button data-action="refresh">Try Again</button>
  </section>
  <div id="contextMenu" class="context-menu hidden" role="menu" aria-label="Git actions"></div>
  <div id="toast" class="toast hidden" role="status"></div>
  <script nonce="${token}" src="${graphScriptUri}"></script>
  <script nonce="${token}" src="${selectionScriptUri}"></script>
  <script nonce="${token}" src="${scriptUri}"></script>
</body>
</html>`;
}
