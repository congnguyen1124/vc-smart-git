(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const persisted = vscode.getState() || {};
  let state = { repositories: [], commits: [], branches: [] };
  let activeTab = persisted.activeTab || 'changes';
  let selectedCommit;
  let selectedChange;
  let selectedChangeGroup;
  let changeOrder = [];
  let previewRequestKey;
  let fileIcons = {};
  const collapsedChangeGroups = new Set(Array.isArray(persisted.collapsedChangeGroups) ? persisted.collapsedChangeGroups : []);
  let consoleEntries = Array.isArray(persisted.consoleEntries) ? persisted.consoleEntries : [];
  let toastTimer;
  let contextSource;

  const byId = (id) => document.getElementById(id);
  const post = (type, payload = {}) => vscode.postMessage({ type, ...payload });
  const show = (node, visible) => node.classList.toggle('hidden', !visible);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const changeKey = (change) => `${change.mode}:${change.path}`;
  const saveUiState = () => vscode.setState({
    activeTab,
    collapsedChangeGroups: [...collapsedChangeGroups],
    consoleEntries: consoleEntries.slice(-200),
  });

  function setTab(tab) {
    activeTab = tab;
    saveUiState();
    const definitions = [
      ['changes', 'changesTab', 'changesTabButton'],
      ['log', 'logTab', 'logTabButton'],
      ['console', 'consoleTab', 'consoleTabButton'],
    ];
    definitions.forEach(([name, pageId, buttonId]) => {
      show(byId(pageId), tab === name);
      byId(buttonId).classList.toggle('active', tab === name);
      byId(buttonId).setAttribute('aria-selected', String(tab === name));
    });
  }

  function statusFor(change, staged) {
    if (change.conflicted) return 'U';
    const status = staged ? change.indexStatus : change.worktreeStatus;
    return status === '?' ? '?' : status === '.' ? 'M' : status;
  }

  function fileLabel(change) {
    const parts = change.path.split('/');
    return { name: parts.pop() || change.path, directory: parts.join('/') };
  }

  function materialFileIcon(filePath) {
    const source = fileIcons[filePath];
    if (!source) return element('span', 'material-file-icon fallback', '◇');
    const image = element('img', 'material-file-icon');
    image.src = source;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    return image;
  }

  function decorationClass(status) {
    if (status === 'U') return 'decoration-conflict';
    if (status === '?') return 'decoration-untracked';
    if (status === 'A') return 'decoration-added';
    if (status === 'D') return 'decoration-deleted';
    if (status === 'R') return 'decoration-renamed';
    return 'decoration-modified';
  }

  function renderFile(change, mode) {
    const descriptor = { path: change.path, mode, staged: mode === 'staged', conflicted: mode === 'conflict' };
    const row = element('div', `file-row${selectedChange && changeKey(selectedChange) === changeKey(descriptor) ? ' selected' : ''}`);
    row.tabIndex = 0;
    row.dataset.action = 'previewDiff';
    row.dataset.path = change.path;
    row.dataset.mode = mode;
    row.dataset.staged = String(mode === 'staged');
    row.dataset.conflicted = String(mode === 'conflict');
    row.dataset.hasStaged = String(change.hasStagedChange);
    row.dataset.hasWorking = String(change.hasWorkingTreeChange);
    row.dataset.context = 'change';
    const status = statusFor(change, mode === 'staged');
    row.classList.add(decorationClass(status));
    row.append(materialFileIcon(change.path));

    const label = element('div', 'file-name');
    const parts = fileLabel(change);
    label.append(document.createTextNode(parts.name));
    if (parts.directory) label.append(element('span', 'file-dir', parts.directory));
    if (change.originalPath) label.title = `${change.originalPath} → ${change.path}`;
    row.append(label);
    row.append(element('span', `status-letter status-${status}`, status));

    return row;
  }

  function descriptorFor(change) {
    if (change.conflicted) return { change, mode: 'conflict' };
    if (change.hasWorkingTreeChange) return { change, mode: 'unstaged' };
    return { change, mode: 'staged' };
  }

  function renderGroup(targetId, groupId, title, entries) {
    const target = byId(targetId);
    target.replaceChildren();
    if (!entries.length) return;
    const collapsed = collapsedChangeGroups.has(groupId);
    const group = element('section', `group${collapsed ? ' collapsed' : ''}`);
    const header = element('div', `group-header${selectedChangeGroup === groupId ? ' selected' : ''}`);
    header.tabIndex = 0;
    header.dataset.action = 'toggleChangeGroup';
    header.dataset.context = 'changeGroup';
    header.dataset.groupId = groupId;
    header.append(element('span', 'group-chevron', collapsed ? '›' : '⌄'));
    header.append(document.createTextNode(`${title}  ${entries.length} ${entries.length === 1 ? 'file' : 'files'}`));
    group.append(header);
    const body = element('div', 'group-body');
    entries.forEach(({ change, mode }) => body.append(renderFile(change, mode)));
    group.append(body);
    target.append(group);
  }

  function requestSelectedPreview(force = false) {
    if (!selectedChange) return;
    const key = changeKey(selectedChange);
    if (!force && previewRequestKey === key) return;
    previewRequestKey = key;
    post('previewDiff', { path: selectedChange.path, staged: selectedChange.staged });
  }

  function selectChange(descriptor) {
    selectedChange = descriptor;
    selectedChangeGroup = undefined;
    document.querySelectorAll('.group-header').forEach((header) => header.classList.remove('selected'));
    document.querySelectorAll('.file-row').forEach((row) => {
      row.classList.toggle('selected', row.dataset.path === descriptor.path && row.dataset.mode === descriptor.mode);
    });
    saveUiState();
    requestSelectedPreview(true);
  }

  function renderRepositories() {
    const select = byId('repository');
    select.replaceChildren();
    state.repositories.forEach((repository) => {
      const option = element('option', '', repository.name);
      option.value = repository.root;
      option.title = repository.root;
      option.selected = repository.root === state.activeRoot;
      select.append(option);
    });
  }

  function renderChanges() {
    const status = state.status;
    if (!status) return;
    const isUnversioned = (change) => change.indexStatus === '?' && change.worktreeStatus === '?';
    const changes = status.changes.filter((change) => !isUnversioned(change)).map(descriptorFor);
    const unversioned = status.changes.filter(isUnversioned).map(descriptorFor);
    const entries = [...changes, ...unversioned];
    changeOrder = entries.map(({ change, mode }) => ({
      path: change.path,
      mode,
      staged: mode === 'staged',
      conflicted: mode === 'conflict',
    }));
    if (!selectedChange || !changeOrder.some((entry) => changeKey(entry) === changeKey(selectedChange))) {
      selectedChange = changeOrder[0];
    }

    renderGroup('changesGroup', 'changes', 'Changes', changes);
    renderGroup('unversionedGroup', 'unversioned', 'Unversioned Files', unversioned);
    show(byId('cleanState'), status.changes.length === 0);
    byId('changeCount').textContent = status.changes.length ? String(status.changes.length) : '';
    byId('branchBadge').textContent = status.branch;
    const operation = state.operation;
    show(byId('operationBanner'), Boolean(operation));
    byId('operationText').textContent = operation ? `${operation[0].toUpperCase()}${operation.slice(1)} in progress` : '';
    if (selectedChange) requestSelectedPreview();
    else renderDiffPreview({ path: '', diff: '' });
  }

  function humanDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function renderBranches() {
    const target = byId('branchTree');
    target.replaceChildren();
    const filter = byId('branchFilter').value.trim().toLowerCase();
    const appendSection = (title, branches, remote) => {
      const filtered = branches.filter((branch) => !filter || branch.name.toLowerCase().includes(filter));
      if (!filtered.length) return;
      target.append(element('div', 'branch-section-title', title));
      filtered.forEach((branch) => {
        const row = element('div', `branch-row${branch.current ? ' current' : ''}`);
        row.dataset.context = 'branch';
        row.dataset.branch = branch.name;
        row.dataset.remote = String(remote);
        row.dataset.current = String(branch.current);
        if (!remote) {
          row.tabIndex = 0;
        }
        row.append(element('span', 'branch-icon', branch.current ? '◆' : remote ? '☆' : '⑂'));
        row.append(element('span', 'ellipsis', branch.name));
        if (branch.tracking) row.append(element('span', 'branch-tracking', branch.tracking));
        target.append(row);
      });
    };
    appendSection('Local', state.branches.filter((branch) => !branch.remote), false);
    appendSection('Remote', state.branches.filter((branch) => branch.remote), true);
  }

  function renderLog() {
    const filter = byId('logFilter').value.trim().toLowerCase();
    const list = byId('logList');
    list.replaceChildren();
    const commits = state.commits.filter((commit) => !filter || [commit.subject, commit.authorName, commit.hash, ...commit.refs].join(' ').toLowerCase().includes(filter));
    commits.forEach((commit) => {
      const row = element('div', `commit-row${selectedCommit === commit.hash ? ' selected' : ''}`);
      row.dataset.action = 'showCommit';
      row.dataset.hash = commit.hash;
      row.dataset.context = 'commit';
      row.setAttribute('role', 'listitem');
      row.tabIndex = 0;
      const graph = element('span', 'graph-cell');
      graph.append(element('span', 'graph-dot'));
      row.append(graph);
      const subject = element('span', 'commit-subject', commit.subject);
      subject.title = `${commit.shortHash} ${commit.subject}`;
      row.append(subject);
      const refs = element('span', 'commit-refs');
      commit.refs.forEach((ref) => refs.append(element('span', 'ref', ref)));
      row.append(refs);
      row.append(element('span', 'commit-author', commit.authorName));
      row.append(element('span', 'commit-date', humanDate(commit.authoredAt)));
      list.append(row);
    });
    if (!commits.length) list.append(element('div', 'empty', filter ? 'No matching commits' : 'No commits yet'));
  }

  function treeNode() {
    return { directories: new Map(), files: [] };
  }

  function renderCommitFiles(files, hash) {
    const root = treeNode();
    files.forEach((file) => {
      const parts = file.path.split('/');
      let cursor = root;
      parts.slice(0, -1).forEach((part) => {
        if (!cursor.directories.has(part)) cursor.directories.set(part, treeNode());
        cursor = cursor.directories.get(part);
      });
      cursor.files.push({ ...file, name: parts[parts.length - 1] || file.path });
    });
    const target = byId('commitFileTree');
    target.replaceChildren();

    const appendNode = (node, parent) => {
      [...node.directories.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([name, child]) => {
        const details = element('details', 'file-tree-folder');
        details.open = true;
        details.append(element('summary', '', `▱ ${name}`));
        const children = element('div', 'file-tree-children');
        appendNode(child, children);
        details.append(children);
        parent.append(details);
      });
      node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((file) => {
        const row = element('div', `commit-file-row ${decorationClass(file.status)}`);
        row.dataset.action = 'openCommitDiff';
        row.dataset.hash = hash;
        row.dataset.path = file.path;
        row.dataset.context = 'commitFile';
        if (file.originalPath) row.dataset.originalPath = file.originalPath;
        row.tabIndex = 0;
        row.append(materialFileIcon(file.path));
        row.append(element('span', 'ellipsis', file.name));
        row.append(element('span', `status-letter status-${file.status}`, file.status));
        row.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
        parent.append(row);
      });
    };
    appendNode(root, target);
  }

  function renderDiffPreview(message) {
    byId('diffTitle').textContent = message.path || 'Select a changed file';
    byId('diffMeta').textContent = message.path
      ? `${message.staged ? 'HEAD → Index' : message.conflicted ? 'Unmerged conflict' : 'Index → Working Tree'}  ·  ${message.path}`
      : 'Choose a file on the left to preview its changes.';
    const target = byId('diffBody');
    target.replaceChildren();
    if (!message.diff) {
      target.append(element('div', 'diff-placeholder', message.path ? 'No textual differences to display.' : 'Select a changed file to preview its diff.'));
      byId('diffStats').textContent = '';
      return;
    }

    let oldLine;
    let newLine;
    let additions = 0;
    let deletions = 0;
    message.diff.split('\n').forEach((line) => {
      let className = 'diff-line';
      let oldLabel = '';
      let newLabel = '';
      const hunk = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        className += ' hunk';
      } else if (/^(diff |index |--- |\+\+\+ )/.test(line)) {
        className += ' header';
      } else if (line.startsWith('+')) {
        className += ' add';
        newLabel = newLine === undefined ? '' : String(newLine++);
        additions += 1;
      } else if (line.startsWith('-')) {
        className += ' delete';
        oldLabel = oldLine === undefined ? '' : String(oldLine++);
        deletions += 1;
      } else if (line.startsWith(' ')) {
        oldLabel = oldLine === undefined ? '' : String(oldLine++);
        newLabel = newLine === undefined ? '' : String(newLine++);
      }
      const row = element('div', className);
      row.append(element('span', 'line-no', oldLabel), element('span', 'line-no', newLabel), element('span', 'code', line));
      target.append(row);
    });
    byId('diffStats').textContent = `+${additions}  −${deletions}`;
  }

  function renderConsole() {
    const target = byId('consoleList');
    target.replaceChildren();
    if (!consoleEntries.length) {
      target.append(element('div', 'muted', 'Git command activity will appear here.'));
      return;
    }
    consoleEntries.forEach((entry) => {
      const row = element('div', `console-entry ${entry.level}`);
      const time = new Date(entry.timestamp);
      const timeText = Number.isNaN(time.valueOf()) ? '' : time.toLocaleTimeString();
      row.append(
        element('span', 'console-time', timeText),
        element('span', 'console-marker', entry.level === 'command' ? '›' : entry.level === 'success' ? '✓' : '×'),
        element('span', 'console-message', entry.message),
      );
      target.append(row);
    });
    target.scrollTop = target.scrollHeight;
  }

  function render() {
    show(byId('loading'), false);
    const hasRepository = Boolean(state.activeRoot && state.status);
    show(byId('app'), hasRepository);
    show(byId('noRepository'), !hasRepository);
    if (!hasRepository) return;
    renderRepositories();
    renderChanges();
    renderBranches();
    renderLog();
    renderConsole();
    setTab(activeTab);
  }

  function toast(message) {
    clearTimeout(toastTimer);
    byId('toast').textContent = message;
    show(byId('toast'), true);
    toastTimer = setTimeout(() => show(byId('toast'), false), 3000);
  }

  function moveSelectedChange(offset) {
    if (!changeOrder.length) return;
    const index = Math.max(0, changeOrder.findIndex((entry) => selectedChange && changeKey(entry) === changeKey(selectedChange)));
    selectChange(changeOrder[(index + offset + changeOrder.length) % changeOrder.length]);
  }

  function separator() {
    return { separator: true };
  }

  function contextItems(source) {
    const kind = source.dataset.context;
    if (kind === 'change') {
      const staged = source.dataset.staged === 'true';
      const conflicted = source.dataset.conflicted === 'true';
      const hasStaged = source.dataset.hasStaged === 'true';
      const hasWorking = source.dataset.hasWorking === 'true';
      const items = [
        { label: 'Show Diff', action: 'openDiff' },
        { label: 'Show Diff in a New Tab', action: 'openDiffNew' },
        { label: 'Jump to Source', action: 'openSource' },
        { label: 'Copy Path/Reference…', action: 'copyPath' },
        separator(),
      ];
      if (conflicted) {
        items.push(
          { label: 'Resolve Conflicts', heading: true },
          { label: '  Open Merge Editor', action: 'openMerge' },
          { label: '  Accept Ours', action: 'useOurs' },
          { label: '  Accept Theirs', action: 'useTheirs' },
          { label: '  Mark Resolved', action: 'markResolved' },
        );
      } else {
        if (hasWorking) items.push({ label: 'Stage', action: 'stage' });
        if (hasStaged || staged) items.push({ label: 'Unstage', action: 'unstage' });
        if (hasWorking) items.push({ label: 'Rollback…', action: 'discard', danger: true });
      }
      items.push(separator(), { label: 'Refresh', action: 'refresh' });
      return items;
    }
    if (kind === 'changeGroup') {
      const hasStaged = Boolean(state.status?.changes.some((change) => change.hasStagedChange));
      return [
        ...(hasStaged ? [{ label: 'Commit Staged Changes…', action: 'promptCommit' }] : []),
        { label: 'Stage All', action: 'stageAll' },
        ...(hasStaged ? [{ label: 'Unstage All', action: 'unstageAll' }] : []),
        separator(),
        { label: 'Refresh', action: 'refresh' },
      ];
    }
    if (kind === 'changesRoot') {
      const hasStaged = Boolean(state.status?.changes.some((change) => change.hasStagedChange));
      return [
        ...(hasStaged ? [{ label: 'Commit Staged Changes…', action: 'promptCommit' }] : []),
        { label: 'Stage All', action: 'stageAll' },
        { label: 'Unstage All', action: 'unstageAll' },
        separator(),
        { label: 'Refresh', action: 'refresh' },
      ];
    }
    if (kind === 'repository') {
      return [
        { label: 'Fetch', action: 'fetch' },
        { label: 'Pull', action: 'pull' },
        { label: 'Push', action: 'push' },
        separator(),
        { label: 'Refresh', action: 'refresh' },
      ];
    }
    if (kind === 'branch') {
      const remote = source.dataset.remote === 'true';
      const current = source.dataset.current === 'true';
      return [
        ...(!remote && !current ? [{ label: 'Checkout', action: 'switchBranch' }] : []),
        { label: 'New Branch from Selected…', action: 'newBranchFromRef' },
        { label: 'Copy Branch Name', action: 'copyBranch' },
        ...(!remote && !current ? [separator(), { label: 'Delete Branch…', action: 'deleteBranch', danger: true }] : []),
      ];
    }
    if (kind === 'commit') {
      const commit = state.commits.find((entry) => entry.hash === source.dataset.hash);
      const parent = commit?.parents?.[0];
      const child = state.commits.find((entry) => entry.parents?.includes(source.dataset.hash));
      return [
        { label: 'Show Commit Details', action: 'showCommit' },
        { label: 'Compare with Local', action: 'compareWithLocal' },
        separator(),
        { label: 'Reset Current Branch to Here…', action: 'resetToCommit', danger: true },
        { label: 'Revert Commit…', action: 'revertCommit' },
        { label: 'Cherry-Pick…', action: 'cherryPick' },
        separator(),
        { label: 'New Branch…', action: 'branchFromCommit' },
        { label: 'New Tag…', action: 'tagFromCommit' },
        { label: 'Checkout Revision…', action: 'checkoutCommit' },
        { label: 'Copy Revision Number', action: 'copyHash' },
        ...(parent || child ? [
          separator(),
          ...(child ? [{ label: 'Go to Child Commit', action: 'navigateCommit', hash: child.hash }] : []),
          ...(parent ? [{ label: 'Go to Parent Commit', action: 'navigateCommit', hash: parent }] : []),
        ] : []),
      ];
    }
    if (kind === 'commitFile') {
      return [
        { label: 'Show Diff', action: 'openCommitDiff' },
        { label: 'Copy Path/Reference…', action: 'copyPath' },
      ];
    }
    return [];
  }

  function closeContextMenu() {
    show(byId('contextMenu'), false);
    byId('contextMenu').replaceChildren();
    contextSource = undefined;
  }

  function openContextMenu(source, clientX, clientY) {
    const items = contextItems(source);
    if (!items.length) return;
    const menu = byId('contextMenu');
    menu.replaceChildren();
    contextSource = source;
    items.forEach((item) => {
      if (item.separator) {
        menu.append(element('div', 'context-separator'));
        return;
      }
      const button = element('button', `context-item${item.danger ? ' danger' : ''}${item.heading ? ' heading' : ''}`, item.label);
      button.setAttribute('role', 'menuitem');
      if (item.heading) {
        button.disabled = true;
      } else {
        button.dataset.action = item.action;
        Object.entries(source.dataset).forEach(([key, value]) => { button.dataset[key] = value; });
        if (item.hash) button.dataset.hash = item.hash;
      }
      menu.append(button);
    });
    show(menu, true);
    menu.style.left = '0px';
    menu.style.top = '0px';
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - height - 4))}px`;
    menu.querySelector('.context-item:not(:disabled)')?.focus();
  }

  function selectCommit(hash) {
    if (!hash || !state.commits.some((commit) => commit.hash === hash)) return;
    selectedCommit = hash;
    post('showCommit', { hash });
    renderLog();
    document.querySelector(`.commit-row[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function dispatch(action, target) {
    const path = target.dataset.path;
    const hash = target.dataset.hash || selectedCommit;
    switch (action) {
      case 'refresh': case 'fetch': case 'pull': case 'push': case 'stageAll': case 'unstageAll': case 'continueOperation': case 'abortOperation':
        post(action); break;
      case 'stage': case 'unstage': case 'discard': case 'markResolved': case 'useOurs': case 'useTheirs': case 'openMerge':
        if (path) post(action, { paths: [path] }); break;
      case 'previewDiff':
        if (path) selectChange({ path, mode: target.dataset.mode, staged: target.dataset.staged === 'true', conflicted: target.dataset.conflicted === 'true' });
        break;
      case 'toggleChangeGroup': {
        const groupId = target.dataset.groupId;
        if (!groupId) break;
        selectedChangeGroup = groupId;
        if (collapsedChangeGroups.has(groupId)) collapsedChangeGroups.delete(groupId);
        else collapsedChangeGroups.add(groupId);
        saveUiState();
        renderChanges();
        break;
      }
      case 'openDiff':
        if (path) post('openDiff', { path, staged: target.dataset.staged === 'true' }); break;
      case 'openDiffNew':
        if (path) post('openDiff', { path, staged: target.dataset.staged === 'true', permanent: true }); break;
      case 'openSource': if (path) post('openSource', { path }); break;
      case 'copyPath': if (path) post('copyPath', { path }); break;
      case 'openSelectedDiff':
        if (selectedChange) post(selectedChange.conflicted ? 'openMerge' : 'openDiff', selectedChange.conflicted
          ? { paths: [selectedChange.path] }
          : { path: selectedChange.path, staged: selectedChange.staged });
        break;
      case 'previousChange': moveSelectedChange(-1); break;
      case 'nextChange': moveSelectedChange(1); break;
      case 'promptCommit': post('promptCommit'); break;
      case 'newBranch': post('newBranch'); break;
      case 'newBranchFromRef': if (target.dataset.branch) post('newBranchFromRef', { ref: target.dataset.branch }); break;
      case 'deleteBranch': post('deleteBranch', { branch: target.dataset.branch }); break;
      case 'switchBranch': if (target.dataset.branch) post('switchBranch', { branch: target.dataset.branch }); break;
      case 'copyBranch': if (target.dataset.branch) post('copyText', { text: target.dataset.branch, label: 'Branch name copied' }); break;
      case 'showCommit':
        selectCommit(hash);
        break;
      case 'branchFromCommit': if (hash) post('branchFromCommit', { hash }); break;
      case 'tagFromCommit': if (hash) post('tagFromCommit', { hash }); break;
      case 'checkoutCommit': if (hash) post('checkoutCommit', { hash }); break;
      case 'compareWithLocal': if (hash) post('compareWithLocal', { hash }); break;
      case 'resetToCommit': if (hash) post('resetToCommit', { hash }); break;
      case 'cherryPick': if (hash) post('cherryPick', { hash }); break;
      case 'revertCommit': if (hash) post('revertCommit', { hash }); break;
      case 'copyHash': if (hash) post('copyHash', { hash }); break;
      case 'navigateCommit': selectCommit(target.dataset.hash); break;
      case 'openCommitDiff':
        post('openCommitDiff', { hash: target.dataset.hash, path, originalPath: target.dataset.originalPath }); break;
      case 'clearConsole': consoleEntries = []; saveUiState(); renderConsole(); break;
    }
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-context-trigger]');
    if (trigger) {
      event.stopPropagation();
      const source = trigger.closest('[data-context]');
      const rect = trigger.getBoundingClientRect();
      if (source) openContextMenu(source, rect.right, rect.bottom);
      return;
    }
    const target = event.target.closest('[data-tab], [data-action]');
    if (!target) {
      closeContextMenu();
      return;
    }
    if (target.dataset.tab) {
      closeContextMenu();
      setTab(target.dataset.tab);
      return;
    }
    event.stopPropagation();
    dispatch(target.dataset.action, target);
    if (target.closest('#contextMenu')) closeContextMenu();
  });

  document.addEventListener('contextmenu', (event) => {
    const source = event.target.closest('[data-context]');
    if (!source) {
      closeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (source.dataset.context === 'change' && source.dataset.path) {
      selectChange({
        path: source.dataset.path,
        mode: source.dataset.mode,
        staged: source.dataset.staged === 'true',
        conflicted: source.dataset.conflicted === 'true',
      });
    } else if (source.dataset.context === 'commit' && source.dataset.hash) {
      selectedCommit = source.dataset.hash;
      document.querySelectorAll('.commit-row').forEach((row) => row.classList.toggle('selected', row === source));
      post('showCommit', { hash: selectedCommit });
    }
    openContextMenu(source, event.clientX, event.clientY);
  });

  document.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.file-row');
    if (!row?.dataset.path) return;
    if (row.dataset.conflicted === 'true') post('openMerge', { paths: [row.dataset.path] });
    else post('openDiff', { path: row.dataset.path, staged: row.dataset.staged === 'true' });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeContextMenu();
      return;
    }
    const target = event.target.closest('[data-action]');
    if ((event.key === 'Enter' || event.key === ' ') && target && !target.matches('button')) {
      event.preventDefault();
      dispatch(target.dataset.action, target);
    }
  });

  window.addEventListener('blur', closeContextMenu);
  document.addEventListener('scroll', closeContextMenu, true);

  byId('repository').addEventListener('change', (event) => post('selectRepository', { root: event.target.value }));
  byId('logFilter').addEventListener('input', renderLog);
  byId('branchFilter').addEventListener('input', renderBranches);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      state = message.state;
      fileIcons = message.fileIcons || {};
      previewRequestKey = undefined;
      render();
    } else if (message.type === 'loading') {
      show(byId('loading'), message.value && !state.status);
    } else if (message.type === 'diffPreview') {
      renderDiffPreview(message);
    } else if (message.type === 'commitDetails') {
      selectedCommit = message.hash;
      fileIcons = { ...fileIcons, ...(message.fileIcons || {}) };
      byId('detailsTitle').textContent = message.title;
      byId('detailsBody').textContent = message.details;
      renderCommitFiles(message.files || [], message.hash);
      show(byId('commitEmpty'), false);
      show(byId('commitDetails'), true);
      renderLog();
    } else if (message.type === 'appendCommit') {
      if (message.commit && !state.commits.some((commit) => commit.hash === message.commit.hash)) {
        state.commits.push(message.commit);
        state.commits.sort((left, right) => Date.parse(right.authoredAt) - Date.parse(left.authoredAt));
        renderLog();
      }
    } else if (message.type === 'revealCommit') {
      byId('logFilter').value = '';
      setTab('log');
      selectCommit(message.hash);
    } else if (message.type === 'consoleEntry') {
      consoleEntries.push(message);
      consoleEntries = consoleEntries.slice(-500);
      saveUiState();
      renderConsole();
    } else if (message.type === 'toast') {
      toast(message.message);
    }
  });

  renderConsole();
  post('ready');
})();
