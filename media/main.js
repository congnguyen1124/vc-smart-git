(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { resolveChangeSelection } = globalThis.SmartGitChangeSelection;
  const persisted = vscode.getState() || {};
  let state = { repositories: [], commits: [], branches: [] };
  let activeTab = persisted.activeTab || 'changes';
  let selectedCommit;
  let logRef = '';
  let logAuthor;
  let filteredCommits;
  let logRequestId = 0;
  let logError = '';
  let logSearchTimer;
  let visibleCommits = [];
  let expandedCommit;
  let hoveredLogTip;
  let logCommitsByHash = new Map();
  let openLogFilterType;
  let logAuthors;
  let logAuthorsError = false;
  let logAuthorRequestId = 0;
  let selectedChange;
  let selectedChangeKeys = new Set();
  let changeSelectionAnchor;
  let selectedChangeGroup;
  let conflictViewOpen = false;
  let selectedConflictPath;
  let changeOrder = [];
  let previewRequestKey;
  let fileIcons = {};
  const collapsedChangeGroups = new Set(Array.isArray(persisted.collapsedChangeGroups) ? persisted.collapsedChangeGroups : []);
  const collapsedBranchGroups = new Set(Array.isArray(persisted.collapsedBranchGroups) ? persisted.collapsedBranchGroups : []);
  let logPaneWidths = persisted.logPaneWidths && typeof persisted.logPaneWidths === 'object'
    ? { left: Number(persisted.logPaneWidths.left) || undefined, right: Number(persisted.logPaneWidths.right) || undefined }
    : {};
  let activePaneResize;
  let consoleEntries = Array.isArray(persisted.consoleEntries) ? persisted.consoleEntries : [];
  let toastTimer;
  let contextSource;

  const byId = (id) => document.getElementById(id);
  const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
    collapsedBranchGroups: [...collapsedBranchGroups],
    logPaneWidths,
    consoleEntries: consoleEntries.slice(-200),
  });

  function setTab(tab) {
    const enteringLog = tab === 'log' && activeTab !== 'log';
    if (tab !== 'log') {
      closeLogFilter();
      highlightLogTrace();
    }
    activeTab = tab;
    saveUiState();
    const definitions = [
      ['changes', 'changesTab', 'changesTabButton'],
      ['log', 'logTab', 'logTabButton'],
      ['console', 'consoleTab', 'consoleTabButton'],
    ];
    definitions.forEach(([name, pageId, buttonId]) => {
      show(byId(pageId), !conflictViewOpen && tab === name);
      byId(buttonId).classList.toggle('active', tab === name);
      byId(buttonId).setAttribute('aria-selected', String(tab === name));
    });
    show(byId('conflictView'), conflictViewOpen);
    byId('app').classList.toggle('conflict-mode', conflictViewOpen);
    if (enteringLog && (logRef || logAuthor)) {
      requestLog(true);
      renderLog();
    }
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
    const key = changeKey(descriptor);
    const selected = selectedChangeKeys.has(key);
    const active = selectedChange && changeKey(selectedChange) === key;
    const row = element('div', `file-row${selected ? ' selected' : ''}${active ? ' active' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
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

  function selectedChangeModel() {
    return selectedChange && state.status?.changes.find((change) => change.path === selectedChange.path);
  }

  function descriptorFromNode(node) {
    const path = node?.dataset.path;
    if (!path) return undefined;
    return {
      path,
      mode: node.dataset.mode,
      staged: node.dataset.staged === 'true',
      conflicted: node.dataset.conflicted === 'true',
    };
  }

  function selectedChangeModels() {
    return changeOrder
      .filter((descriptor) => selectedChangeKeys.has(changeKey(descriptor)))
      .map((descriptor) => ({
        descriptor,
        change: state.status?.changes.find((entry) => entry.path === descriptor.path),
      }))
      .filter((entry) => Boolean(entry.change));
  }

  function selectionForSource(source) {
    const descriptor = descriptorFromNode(source);
    const selected = selectedChangeModels();
    if (descriptor && selectedChangeKeys.has(changeKey(descriptor)) && selected.length) {
      return selected;
    }
    const change = descriptor && state.status?.changes.find((entry) => entry.path === descriptor.path);
    return descriptor && change ? [{ descriptor, change }] : selected;
  }

  function selectedPathsForAction(action, source) {
    const matches = selectionForSource(source).filter(({ change }) => {
      if (action === 'stage') return !change.conflicted && change.hasWorkingTreeChange;
      if (action === 'unstage') return !change.conflicted && change.hasStagedChange;
      if (action === 'discard') return !change.conflicted && (change.hasWorkingTreeChange || change.hasStagedChange);
      if (action === 'deleteFiles') return change.kind !== 'deleted';
      return change.conflicted;
    });
    return [...new Set(matches.map(({ descriptor }) => descriptor.path))];
  }

  function updateDiffToolbar() {
    const change = selectedChangeModel();
    const selection = selectedChangeModels();
    const index = changeOrder.findIndex((entry) => selectedChange && changeKey(entry) === changeKey(selectedChange));
    byId('diffFileCounter').textContent = selection.length > 1
      ? `${selection.length} selected`
      : changeOrder.length && index >= 0
      ? `${index + 1}/${changeOrder.length} files`
      : `0/${changeOrder.length} files`;
    show(byId('stageSelected'), selection.some(({ change: entry }) => entry.hasWorkingTreeChange && !entry.conflicted));
    show(byId('unstageSelected'), selection.some(({ change: entry }) => entry.hasStagedChange && !entry.conflicted));
    show(byId('discardSelected'), selection.some(({ change: entry }) => (entry.hasWorkingTreeChange || entry.hasStagedChange) && !entry.conflicted));
    show(byId('diffMenu'), Boolean(change && selectedChange));

    const toolbar = byId('diffToolbar');
    ['path', 'mode', 'staged', 'conflicted', 'hasStaged', 'hasWorking'].forEach((key) => delete toolbar.dataset[key]);
    if (change && selectedChange) {
      toolbar.dataset.path = change.path;
      toolbar.dataset.mode = selectedChange.mode;
      toolbar.dataset.staged = String(selectedChange.staged);
      toolbar.dataset.conflicted = String(change.conflicted);
      toolbar.dataset.hasStaged = String(change.hasStagedChange);
      toolbar.dataset.hasWorking = String(change.hasWorkingTreeChange);
    }
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
    const chevron = element('span', `chevron-icon group-chevron${collapsed ? ' collapsed' : ''}`);
    chevron.setAttribute('aria-hidden', 'true');
    header.append(chevron);
    header.append(element('strong', 'group-title', title));
    header.append(element('span', 'group-count', `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`));
    group.append(header);
    const body = element('div', 'group-body');
    if (groupId === 'changes') {
      const conflicts = entries.filter(({ change }) => change.conflicted);
      const ordinary = entries.filter(({ change }) => !change.conflicted);
      if (conflicts.length) {
        const conflictGroupId = 'mergeConflicts';
        const conflictCollapsed = collapsedChangeGroups.has(conflictGroupId);
        const conflictGroup = element('section', `conflict-subgroup${conflictCollapsed ? ' collapsed' : ''}`);
        const conflictHeader = element('div', 'conflict-subgroup-header');
        conflictHeader.tabIndex = 0;
        conflictHeader.dataset.action = 'toggleConflictGroup';
        conflictHeader.dataset.groupId = conflictGroupId;
        const conflictChevron = element('span', `chevron-icon group-chevron${conflictCollapsed ? ' collapsed' : ''}`);
        conflictChevron.setAttribute('aria-hidden', 'true');
        conflictHeader.append(conflictChevron);
        conflictHeader.append(element('strong', 'conflict-subgroup-title', 'Merge Conflicts'));
        const resolve = element('button', 'conflict-resolve-link', 'Resolve');
        resolve.dataset.action = 'openConflictResolver';
        resolve.title = 'Open the conflict resolver';
        conflictHeader.append(resolve);
        conflictHeader.append(element('span', 'group-count', `${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}`));
        conflictGroup.append(conflictHeader);
        const conflictBody = element('div', 'conflict-subgroup-body');
        conflicts.forEach(({ change, mode }) => conflictBody.append(renderFile(change, mode)));
        conflictGroup.append(conflictBody);
        body.append(conflictGroup);
      }
      ordinary.forEach(({ change, mode }) => body.append(renderFile(change, mode)));
    } else {
      entries.forEach(({ change, mode }) => body.append(renderFile(change, mode)));
    }
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

  function syncChangeSelectionClasses() {
    document.querySelectorAll('.file-row').forEach((row) => {
      const descriptor = descriptorFromNode(row);
      const key = descriptor && changeKey(descriptor);
      const selected = Boolean(key && selectedChangeKeys.has(key));
      const active = Boolean(key && selectedChange && changeKey(selectedChange) === key);
      row.classList.toggle('selected', selected);
      row.classList.toggle('active', active);
      row.setAttribute('aria-selected', String(selected));
    });
  }

  function selectChange(descriptor, modifiers = {}) {
    const targetKey = changeKey(descriptor);
    const result = resolveChangeSelection(
      changeOrder.map(changeKey),
      [...selectedChangeKeys],
      changeSelectionAnchor,
      targetKey,
      modifiers,
    );
    selectedChangeKeys = new Set(result.keys);
    changeSelectionAnchor = result.anchorKey;
    selectedChange = selectedChangeKeys.has(targetKey)
      ? descriptor
      : changeOrder.find((entry) => selectedChangeKeys.has(changeKey(entry))) || descriptor;
    selectedChangeGroup = undefined;
    document.querySelectorAll('.group-header').forEach((header) => header.classList.remove('selected'));
    syncChangeSelectionClasses();
    saveUiState();
    updateDiffToolbar();
    requestSelectedPreview(true);
  }

  function activateSelectedChange(descriptor) {
    selectedChange = descriptor;
    selectedChangeGroup = undefined;
    syncChangeSelectionClasses();
    updateDiffToolbar();
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
    const availableKeys = new Set(changeOrder.map(changeKey));
    selectedChangeKeys = new Set([...selectedChangeKeys].filter((key) => availableKeys.has(key)));
    if (!selectedChange || !changeOrder.some((entry) => changeKey(entry) === changeKey(selectedChange))) {
      selectedChange = changeOrder[0];
    }
    if (selectedChange && selectedChangeKeys.size === 0) {
      selectedChangeKeys.add(changeKey(selectedChange));
    }
    if (!changeSelectionAnchor || !availableKeys.has(changeSelectionAnchor)) {
      changeSelectionAnchor = selectedChange && changeKey(selectedChange);
    }

    renderGroup('changesGroup', 'changes', 'Changes', changes);
    renderGroup('unversionedGroup', 'unversioned', 'Unversioned Files', unversioned);
    show(byId('cleanState'), status.changes.length === 0);
    byId('changeCount').textContent = status.changes.length ? String(status.changes.length) : '';
    byId('branchBadge').textContent = status.branch;
    const operation = state.operation;
    show(byId('operationBanner'), Boolean(operation));
    byId('operationText').textContent = operation ? `${operation[0].toUpperCase()}${operation.slice(1)} in progress` : '';
    updateDiffToolbar();
    if (selectedChange) requestSelectedPreview();
    else renderDiffPreview({ path: '', diff: '' });
  }

  function renderConflictResolver() {
    const conflictState = state.conflicts;
    const conflicts = conflictState?.files || [];
    if (conflictViewOpen && !conflictState && !state.operation) {
      conflictViewOpen = false;
    }
    if (!conflicts.some((conflict) => conflict.path === selectedConflictPath)) {
      selectedConflictPath = conflicts[0]?.path;
    }

    const current = conflictState?.currentBranch || state.status?.branch || 'current branch';
    const incoming = conflictState?.incomingLabel || 'incoming changes';
    const operation = conflictState?.operation || state.operation;
    const operationText = byId('conflictOperationText');
    operationText.replaceChildren();
    if (operation === 'merge') {
      operationText.append(
        document.createTextNode('Merging branch '),
        element('strong', '', incoming),
        document.createTextNode(' into branch '),
        element('strong', '', current),
      );
    } else {
      const label = operation ? `${operation[0].toUpperCase()}${operation.slice(1)}` : 'Merge';
      operationText.append(
        element('strong', '', label),
        document.createTextNode(` conflicts on branch `),
        element('strong', '', current),
      );
    }
    byId('oursColumn').textContent = `Yours (${current})`;
    byId('theirsColumn').textContent = `Theirs (${incoming})`;

    const simple = conflicts.filter((conflict) => conflict.simple);
    const simpleButton = byId('resolveSimpleConflicts');
    simpleButton.disabled = simple.length === 0;
    simpleButton.dataset.paths = JSON.stringify(simple.map((conflict) => conflict.path));
    simpleButton.title = simple.length
      ? `Safely resolve ${simple.length} conflict${simple.length === 1 ? '' : 's'} where both sides are identical or both deleted`
      : 'Disabled because the remaining conflicts require a manual choice';
    byId('simpleConflictHint').textContent = simple.length
      ? `${simple.length} safe automatic resolution${simple.length === 1 ? '' : 's'} available`
      : conflicts.length ? 'No conflict can be resolved automatically without choosing a side.' : '';

    const list = byId('conflictList');
    list.replaceChildren();
    if (conflicts.length) {
      const section = element('div', 'conflict-section-header');
      section.append(
        element('span', 'conflict-section-mark', '−'),
        element('strong', '', 'Unresolved'),
        element('span', 'group-count', `${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}`),
      );
      list.append(section);
    }
    conflicts.forEach((conflict) => {
      const row = element('div', `conflict-row${selectedConflictPath === conflict.path ? ' selected' : ''}`);
      row.dataset.conflictPath = conflict.path;
      row.setAttribute('role', 'row');

      const file = element('div', 'conflict-file');
      file.dataset.action = 'resolveConflictFile';
      file.dataset.conflictPath = conflict.path;
      file.tabIndex = 0;
      file.append(materialFileIcon(conflict.path));
      const parts = fileLabel({ path: conflict.path });
      const label = element('span', 'conflict-file-label', parts.name);
      if (parts.directory) label.append(element('span', 'file-dir', parts.directory));
      file.append(label);
      row.append(file);

      [['ours', conflict.ours, conflict.oursAvailable], ['theirs', conflict.theirs, conflict.theirsAvailable]].forEach(([side, status, available]) => {
        const cell = element('div', 'conflict-side');
        cell.append(element('span', 'conflict-side-status', status));
        const accept = element('button', '', 'Accept');
        accept.dataset.action = side === 'ours' ? 'useOurs' : 'useTheirs';
        accept.dataset.conflictPath = conflict.path;
        accept.disabled = !available && status !== 'Deleted';
        accept.title = status === 'Deleted' ? `Accept deletion from ${side}` : `Accept ${side}`;
        cell.append(accept);
        row.append(cell);
      });
      list.append(row);
    });

    show(byId('conflictEmpty'), conflicts.length === 0);
    byId('finishConflicts').disabled = conflicts.length > 0 || !operation;
    byId('resolveManually').disabled = conflicts.length === 0;
  }

  function humanDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : dateFormatter.format(date);
  }

  function renderBranches() {
    const target = byId('branchTree');
    const previousScroll = target.scrollTop;
    target.replaceChildren();
    const filter = byId('branchFilter').value.trim().toLowerCase();

    const appendBranchRow = (branch, label, depth, kind) => {
      const checkedOut = Boolean(branch.current || branch.worktreePath);
      const row = element('button', `branch-row branch-${kind}${branch.current ? ' current' : ''}`);
      row.dataset.action = 'setLogRef';
      row.dataset.logRef = branch.ref;
      if (branch.hash) row.dataset.logTip = branch.hash;
      if (kind === 'local' || kind === 'remote') row.dataset.context = 'branch';
      row.dataset.branch = branch.name;
      row.dataset.remote = String(branch.remote);
      row.dataset.current = String(branch.current);
      row.dataset.checkedOut = String(checkedOut);
      row.style.setProperty('--branch-indent', `${20 + depth * 15}px`);
      row.setAttribute('aria-pressed', String(logRef === branch.ref));
      const details = [branch.name];
      if (branch.current) details.push('Currently checked out (HEAD)');
      else if (branch.worktreePath) details.push(`Checked out in ${branch.worktreePath}`);
      if (branch.upstream) details.push(`Tracks ${branch.upstream}`);
      if (branch.ahead || branch.behind) details.push(`Ahead ${branch.ahead} · Behind ${branch.behind}`);
      row.title = details.join('\n');
      const icon = element('span', 'branch-icon', { all: '≡', head: '◆', local: '⑂', remote: '◇', tag: '◇' }[kind]);
      icon.setAttribute('aria-hidden', 'true');
      row.append(icon);
      row.append(element('span', 'ellipsis', label));
      const badges = element('span', 'branch-state-badges');
      if (branch.current && kind !== 'head') badges.append(element('span', 'branch-state checkout', 'HEAD'));
      else if (branch.worktreePath) badges.append(element('span', 'branch-state checkout', 'worktree'));
      if (branch.ahead) badges.append(element('span', 'branch-state ahead', `↑${branch.ahead}`));
      if (branch.behind) badges.append(element('span', 'branch-state behind', `↓${branch.behind}`));
      if (badges.childElementCount) row.append(badges);
      target.append(row);
    };

    const appendNodes = (nodes, sectionId, pathParts = [], depth = 0) => {
      [...nodes.entries()].sort(([left, a], [right, b]) => Number(Boolean(b.branch?.current))
        - Number(Boolean(a.branch?.current)) || left.localeCompare(right)).forEach(([name, node]) => {
        const currentPath = [...pathParts, name];
        if (node.children.size) {
          const groupId = `${sectionId}:${currentPath.join('/')}`;
          const collapsed = !filter && collapsedBranchGroups.has(groupId);
          const folder = element('button', 'branch-folder-row');
          folder.dataset.action = 'toggleBranchGroup';
          folder.dataset.branchGroup = groupId;
          folder.style.setProperty('--branch-indent', `${7 + depth * 15}px`);
          folder.setAttribute('aria-expanded', String(!collapsed));
          folder.append(element('span', `chevron-icon${collapsed ? ' collapsed' : ''}`));
          folder.append(element('span', 'branch-folder-icon', '▱'));
          folder.append(element('span', 'ellipsis', name));
          target.append(folder);
          if (!collapsed) {
            if (node.branch) appendBranchRow(node.branch, name, depth + 1, sectionId);
            appendNodes(node.children, sectionId, currentPath, depth + 1);
          }
        } else if (node.branch) {
          appendBranchRow(node.branch, name, depth, sectionId);
        }
      });
    };

    const appendSection = ({ title, kind, choices }) => {
      const filtered = choices.filter((branch) => branch.name.toLowerCase().includes(filter));
      if (!filtered.length) return;
      const groupId = `section:${kind}`;
      const collapsed = !filter && collapsedBranchGroups.has(groupId);
      const heading = element('button', 'branch-folder-row branch-section-title');
      heading.dataset.action = 'toggleBranchGroup';
      heading.dataset.branchGroup = groupId;
      heading.setAttribute('aria-expanded', String(!collapsed));
      heading.append(element('span', `chevron-icon${collapsed ? ' collapsed' : ''}`), element('span', '', title));
      target.append(heading);
      if (collapsed) return;
      const nodes = new Map();
      filtered.forEach((branch) => {
        let cursor = nodes;
        branch.name.split('/').filter(Boolean).forEach((part, index, parts) => {
          if (!cursor.has(part)) cursor.set(part, { children: new Map(), branch: undefined });
          const node = cursor.get(part);
          if (index === parts.length - 1) node.branch = branch;
          cursor = node.children;
        });
      });
      appendNodes(nodes, kind);
    };
    if (!filter) {
      appendBranchRow({ ref: '', name: 'All branches' }, 'All branches', 0, 'all');
      const head = headChoice();
      if (head) appendBranchRow(head, head.name, 0, 'head');
    }
    logRefGroups().forEach(appendSection);
    if (!target.childElementCount) target.append(element('div', 'empty compact', 'No matching branches or tags'));
    target.scrollTop = previousScroll;
  }

  function headChoice() {
    if (!state.status?.oid) return undefined;
    const branch = state.status.branch;
    return { ref: 'HEAD', hash: state.status.oid, name: branch === '(detached)' ? 'Detached HEAD' : `HEAD · ${branch}` };
  }

  function logRefGroups() {
    return [
      { title: 'Local branches', kind: 'local', choices: state.branches.filter((branch) => !branch.remote) },
      { title: 'Remote branches', kind: 'remote', choices: state.branches.filter((branch) => branch.remote) },
      { title: 'Tags', kind: 'tag', choices: state.tags || [] },
    ];
  }

  function updateLogFilterButtons() {
    const ref = logRef === 'HEAD'
      ? headChoice()
      : logRefGroups().flatMap((group) => group.choices).find((choice) => choice.ref === logRef);
    const branchLabel = ref?.name || 'Branch';
    const userLabel = logAuthor?.name || logAuthor?.email || 'User';
    for (const [kind, label, active] of [['Branch', branchLabel, logRef], ['User', userLabel, logAuthor]]) {
      const button = byId(`log${kind}Button`);
      byId(`log${kind}Label`).textContent = active ? `${kind} · ${label}` : kind;
      button.title = active ? `${kind}: ${label}` : `Filter by ${kind.toLowerCase()}`;
      if (kind === 'User' && logAuthor?.email && logAuthor.name) button.title += ` <${logAuthor.email}>`;
      button.setAttribute('aria-label', button.title);
      button.classList.toggle('filtered', Boolean(active));
    }
    show(byId('clearLogFilters'), Boolean(logRef || logAuthor || byId('logFilter').value));
  }

  function requestLog(keepResults = false) {
    logRequestId += 1;
    logError = '';
    if (!keepResults || (!logRef && !logAuthor)) filteredCommits = undefined;
    if (logRef || logAuthor) {
      post('queryLog', {
        root: state.activeRoot,
        requestId: logRequestId,
        ref: logRef,
        authorName: logAuthor?.name,
        authorEmail: logAuthor?.email,
      });
    }
  }

  function applyLogFilters(ref, author) {
    logRef = ref;
    logAuthor = author;
    requestLog();
    updateLogFilterButtons();
    renderBranches();
    renderLog();
  }

  function closeLogFilter(restoreFocus = false) {
    if (!openLogFilterType) return;
    const button = byId(openLogFilterType === 'branch' ? 'logBranchButton' : 'logUserButton');
    openLogFilterType = undefined;
    button.setAttribute('aria-expanded', 'false');
    show(byId('logFilterPopover'), false);
    if (restoreFocus) button.focus();
  }

  function renderLogFilterChoices() {
    if (!openLogFilterType) return;
    const target = byId('logFilterChoices');
    const query = byId('logChoiceSearch').value.trim().toLowerCase();
    const branchFilter = openLogFilterType === 'branch';
    target.replaceChildren();
    const appendChoice = (label, { ref, authorIndex, selected, email, kind } = {}) => {
      const button = element('button', 'log-filter-choice');
      button.dataset.action = 'chooseLogFilter';
      if (branchFilter) button.dataset.logRef = ref ?? '';
      else if (authorIndex !== undefined) button.dataset.authorIndex = authorIndex;
      button.setAttribute('aria-pressed', String(Boolean(selected)));
      if (kind) button.classList.add(`branch-${kind}`);
      const text = element('span', 'log-choice-text');
      text.append(element('span', 'ellipsis', label));
      if (email) text.append(element('small', 'ellipsis muted', email));
      button.title = email ? `${label} <${email}>` : label;
      button.append(text);
      const check = element('span', 'log-choice-check', selected ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      button.append(check);
      target.append(button);
    };
    if (!query) {
      appendChoice(branchFilter ? 'All branches' : 'All users', { selected: branchFilter ? !logRef : !logAuthor });
    }
    if (branchFilter) {
      const head = headChoice();
      if (head && head.name.toLowerCase().includes(query)) {
        appendChoice(head.name, { ref: head.ref, selected: logRef === head.ref, kind: 'head' });
      }
      for (const { title, kind, choices } of logRefGroups()) {
        const matching = choices.filter((entry) => entry.name.toLowerCase().includes(query))
          .sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)) || a.name.localeCompare(b.name));
        if (!matching.length) continue;
        target.append(element('div', 'log-choice-heading', title));
        matching.forEach((entry) => appendChoice(entry.name, { ref: entry.ref, selected: logRef === entry.ref, kind }));
      }
    } else {
      logAuthors?.forEach((author, authorIndex) => {
        const identity = `${author.name} ${author.email}`.toLowerCase();
        if (!identity.includes(query)) return;
        appendChoice(author.name || author.email, {
          authorIndex,
          selected: author.name === logAuthor?.name && author.email === logAuthor?.email,
          email: author.name ? author.email : '',
        });
      });
      if (logAuthorsError || !logAuthors) {
        target.append(element('div', 'log-choice-heading', logAuthorsError ? 'Unable to load users' : 'Loading users…'));
        return;
      }
    }
    if (!target.childElementCount || (!branchFilter && !query && !logAuthors.length)) {
      target.append(element('div', 'log-choice-heading', query ? 'No matching options' : 'No authors found'));
    }
  }

  function positionLogFilter(button) {
    const rect = button.getBoundingClientRect();
    const popover = byId('logFilterPopover');
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const openAbove = below < 170 && above > below;
    popover.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.setProperty('--log-choice-height', `${Math.max(1, (openAbove ? above : below) - 42)}px`);
    popover.style.top = openAbove ? 'auto' : `${rect.bottom + 3}px`;
    popover.style.bottom = openAbove ? `${window.innerHeight - rect.top + 3}px` : 'auto';
  }

  function openLogFilter(kind, button) {
    if (openLogFilterType === kind) {
      closeLogFilter(true);
      return;
    }
    closeLogFilter();
    openLogFilterType = kind;
    button.setAttribute('aria-expanded', 'true');
    const search = byId('logChoiceSearch');
    search.value = '';
    search.placeholder = kind === 'branch' ? 'Find a branch or tag' : 'Find a name or email';
    show(byId('logFilterPopover'), true);
    if (kind === 'user') {
      logAuthorsError = false;
      post('loadLogAuthors', { root: state.activeRoot, requestId: ++logAuthorRequestId });
    }
    renderLogFilterChoices();
    positionLogFilter(button);
    search.focus();
  }

  const graphColors = [
    'var(--vscode-charts-purple, #a277ff)',
    'var(--vscode-charts-green, #62c29b)',
    'var(--vscode-charts-blue, #75a7e8)',
    'var(--vscode-charts-orange, #d69d55)',
    'var(--vscode-charts-red, #df6b75)',
    'var(--vscode-charts-yellow, #d7ba7d)',
  ];

  function svgNode(tag, attributes = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  const laneX = (lane) => 9 + lane * 15;

  function graphCell(commit, rowLayout, graphWidth) {
    const cell = element('span', 'graph-cell');
    const svg = svgNode('svg', { class: 'graph-svg', viewBox: `0 0 ${graphWidth} 30`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const path = (definition, color, target, child) => {
      const className = child ? 'parent-line' : '';
      const node = svgNode('path', { d: definition, class: `graph-line ${className}`, stroke: graphColors[color % graphColors.length] });
      node.dataset.traceTarget = target;
      if (child) node.dataset.traceChild = child;
      svg.append(node);
      return node;
    };
    rowLayout.continuations.forEach((connection) => {
      path(`M ${laneX(connection.from)} 0 C ${laneX(connection.from)} 10 ${laneX(connection.to)} 20 ${laneX(connection.to)} 30`, connection.color, connection.hash)
        .classList.add('incoming');
    });
    if (rowLayout.hasIncoming) {
      path(`M ${laneX(rowLayout.currentLane)} 0 L ${laneX(rowLayout.currentLane)} 15`, rowLayout.currentColor, commit.hash)
        .classList.add('incoming');
    }
    rowLayout.parentConnections.forEach((connection) => {
      path(`M ${laneX(rowLayout.currentLane)} 15 C ${laneX(rowLayout.currentLane)} 21 ${laneX(connection.to)} 23 ${laneX(connection.to)} 30`, connection.color, connection.hash, commit.hash);
    });
    svg.append(svgNode('circle', {
      class: `graph-node${rowLayout.merge ? ' merge' : ''}`,
      cx: laneX(rowLayout.currentLane),
      cy: 15,
      r: rowLayout.merge ? 5 : 4,
      fill: graphColors[rowLayout.currentColor % graphColors.length],
      stroke: graphColors[rowLayout.currentColor % graphColors.length],
    }));
    cell.append(svg);
    const trigger = element('button', 'graph-node-trigger');
    trigger.type = 'button';
    trigger.dataset.action = 'toggleGraphNode';
    trigger.dataset.hash = commit.hash;
    trigger.dataset.logTip = commit.hash;
    trigger.style.setProperty('--node-x', `${laneX(rowLayout.currentLane)}px`);
    const expanded = expandedCommit === commit.hash;
    trigger.title = `${expanded ? 'Collapse' : 'Expand'} commit ${commit.shortHash}`;
    trigger.setAttribute('aria-label', trigger.title);
    trigger.setAttribute('aria-expanded', String(expanded));
    cell.append(trigger);
    return cell;
  }

  function commitExpansion(commit, layout, graphWidth, visibleHashes) {
    const details = element('div', 'graph-details');
    const rails = svgNode('svg', { class: 'graph-details-rails', viewBox: `0 0 ${graphWidth} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    for (const link of [...layout.continuations, ...layout.parentConnections]) {
      const x = laneX(link.to);
      const line = svgNode('line', {
        class: 'graph-line', x1: x, x2: x, y1: 0, y2: 100,
        stroke: graphColors[link.color % graphColors.length], 'vector-effect': 'non-scaling-stroke',
      });
      line.dataset.traceTarget = link.hash;
      rails.append(line);
    }
    const card = element('div', 'graph-details-card');
    const heading = element('div', 'graph-details-revision');
    heading.append(element('code', 'ellipsis', commit.hash));
    const copy = element('button', '', 'Copy revision');
    copy.dataset.action = 'copyHash';
    copy.dataset.hash = commit.hash;
    heading.append(copy);
    card.append(heading);
    if (commit.body) card.append(element('p', 'graph-details-body', commit.body));
    if (commit.parents.length) {
      const parents = element('div', 'graph-details-parents');
      parents.append(element('span', 'muted', commit.parents.length === 1 ? 'Parent' : 'Parents'));
      for (const parent of commit.parents) {
        const label = parent.slice(0, commit.shortHash.length);
        if (visibleHashes.has(parent)) {
          const link = element('button', '', label);
          link.dataset.action = 'navigateCommit';
          link.dataset.hash = parent;
          link.title = `Go to parent ${label}`;
          parents.append(link);
        } else {
          const labelText = element('code', 'muted', label);
          labelText.title = 'This parent is outside the displayed history';
          parents.append(labelText);
        }
      }
      card.append(parents);
    }
    details.append(rails, card);
    return details;
  }

  function highlightLogTrace(tip, force = false) {
    if (!force && tip === hoveredLogTip) return;
    hoveredLogTip = tip;
    const trace = window.SmartGitLogGraph.traceFirstParent(logCommitsByHash, tip);
    const list = byId('logList');
    const highlighting = visibleCommits.some((commit) => trace.has(commit.hash));
    list.classList.toggle('trace-active', highlighting);
    let following = false;
    for (const entry of list.querySelectorAll('.log-entry')) {
      const hash = entry.dataset.hash;
      const onTrace = trace.has(hash);
      const atTip = hash === tip;
      const wasFollowing = following;
      following ||= onTrace;
      const row = entry.querySelector('.commit-row');
      row.classList.toggle('trace-row', onTrace);
      row.classList.toggle('trace-tip', atTip);
      for (const edge of entry.querySelectorAll('[data-trace-target]')) {
        const { traceTarget, traceChild } = edge.dataset;
        const connectsTrace = traceChild
          ? trace.get(traceChild) === traceTarget && trace.has(traceTarget)
          : (edge.classList.contains('incoming') ? wasFollowing : following) && trace.has(traceTarget);
        edge.classList.toggle('trace-edge', connectsTrace);
      }
    }
  }

  function renderLog() {
    const filter = byId('logFilter').value.trim().toLowerCase();
    const list = byId('logList');
    const source = logRef || logAuthor ? filteredCommits : state.commits;
    const commits = (source || []).filter((commit) => !filter
      || [commit.subject, commit.authorName, commit.authorEmail, commit.hash, ...commit.refs].join(' ').toLowerCase().includes(filter));
    visibleCommits = commits;
    logCommitsByHash = new Map([...state.commits, ...commits].map((commit) => [commit.hash, commit]));
    const visibleHashes = new Set(commits.map((commit) => commit.hash));
    if (selectedCommit && !commits.some((commit) => commit.hash === selectedCommit)) {
      selectedCommit = undefined;
      clearCommitDetails();
    }
    if (!commits.length) {
      const message = logError || (!source ? 'Loading history…' : filter || logRef || logAuthor ? 'No matching commits' : 'No commits yet');
      list.replaceChildren(element('div', 'empty', message));
      highlightLogTrace(hoveredLogTip, true);
      return;
    }
    const { layoutCommitGraph, indexLogBranches, commitRefPresentations } = window.SmartGitLogGraph;
    const layout = layoutCommitGraph(commits, Boolean(filter || logAuthor));
    const branchIndex = indexLogBranches(state.branches);
    const graphWidth = Math.max(30, 18 + (layout.maxLaneCount - 1) * 15);
    byId('logTab').style.setProperty('--graph-width', `${graphWidth}px`);
    const fragment = document.createDocumentFragment();
    const columns = element('div', 'log-columns');
    columns.setAttribute('aria-hidden', 'true');
    columns.append(element('span', '', 'Commit'), element('span', '', 'Author'), element('span', 'commit-date', 'Date'));
    fragment.append(columns);
    commits.forEach((commit, index) => {
      const presentations = commitRefPresentations(commit, state.branches, state.status, branchIndex);
      const isHead = presentations.some((info) => info.type === 'head');
      const row = element('div', `commit-row${selectedCommit === commit.hash ? ' selected' : ''}${isHead ? ' head' : ''}`);
      row.dataset.action = 'showCommit';
      row.dataset.hash = commit.hash;
      row.dataset.context = 'commit';
      row.setAttribute('role', 'listitem');
      row.tabIndex = 0;
      row.title = `${commit.shortHash} · ${commit.authorName} <${commit.authorEmail}>\n${humanDate(commit.authoredAt)}${commit.body ? `\n\n${commit.body}` : ''}`;
      const rowLayout = layout.rows[index];
      row.append(graphCell(commit, rowLayout, graphWidth));
      const summary = element('span', 'commit-summary');
      const subject = element('span', 'commit-subject', commit.subject);
      subject.title = `${commit.shortHash} ${commit.subject}`;
      summary.append(subject);
      if (presentations.length) {
        const refs = element('span', 'commit-refs');
        refs.title = presentations.map((info) => info.title).join('\n');
        presentations.forEach((info) => {
          const ref = element('span', `ref ${info.type}`);
          ref.dataset.logTip = commit.hash;
          ref.append(element('span', 'ref-icon', info.icon), element('span', 'ellipsis', info.label));
          refs.append(ref);
        });
        summary.append(refs);
      }
      row.append(summary);
      const author = element('span', 'commit-author', commit.authorName);
      author.title = `${commit.authorName} <${commit.authorEmail}>`;
      row.append(author);
      row.append(element('span', 'commit-date', humanDate(commit.authoredAt)));
      const entry = element('div', 'log-entry');
      entry.dataset.hash = commit.hash;
      entry.append(row);
      if (expandedCommit === commit.hash) entry.append(commitExpansion(commit, rowLayout, graphWidth, visibleHashes));
      fragment.append(entry);
    });
    const previousScroll = list.scrollTop;
    list.replaceChildren(fragment);
    list.scrollTop = previousScroll;
    highlightLogTrace(hoveredLogTip, true);
  }

  function clearCommitDetails() {
    show(byId('commitEmpty'), true);
    show(byId('commitDetails'), false);
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
    const parts = fileLabel({ path: message.path || '' });
    const change = selectedChangeModel();
    byId('diffFileName').textContent = message.path ? parts.name : 'Select a changed file';
    byId('diffFilePath').textContent = message.path ? parts.directory : '';
    byId('diffRevision').textContent = message.path
      ? message.conflicted
        ? 'Unmerged conflict'
        : change?.kind === 'untracked'
          ? 'Unversioned file · Working tree'
          : message.staged
            ? 'Staged change · HEAD → Index'
            : `${change?.kind === 'deleted' ? 'Deleted file' : 'Current version'} · Working tree`
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
      if (!line || /^(diff --git |index |old mode |new mode |deleted file mode |new file mode |similarity index |rename from |rename to |--- |\+\+\+ |\\ No newline)/.test(line)) {
        return;
      }
      let className = 'diff-line';
      let oldLabel = '';
      let newLabel = '';
      let displayLine = line;
      const hunk = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        className += ' hunk';
        displayLine = `⋯  ${line}`;
      } else if (line.startsWith('+')) {
        className += ' add';
        newLabel = newLine === undefined ? '' : String(newLine++);
        additions += 1;
        displayLine = line.slice(1);
      } else if (line.startsWith('-')) {
        className += ' delete';
        oldLabel = oldLine === undefined ? '' : String(oldLine++);
        deletions += 1;
        displayLine = line.slice(1);
      } else if (line.startsWith(' ')) {
        oldLabel = oldLine === undefined ? '' : String(oldLine++);
        newLabel = newLine === undefined ? '' : String(newLine++);
        displayLine = line.slice(1);
      } else {
        className += ' header';
      }
      const row = element('div', className);
      row.append(element('span', 'line-no', oldLabel), element('span', 'line-no', newLabel), element('span', 'code', displayLine));
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
    renderConflictResolver();
    renderBranches();
    updateLogFilterButtons();
    renderLogFilterChoices();
    renderLog();
    renderConsole();
    setTab(activeTab);
    applyLogPaneWidths();
  }

  function applyLogPaneWidths() {
    const workspace = byId('logTab');
    if (!workspace) return;
    if (Number.isFinite(logPaneWidths.left)) workspace.style.setProperty('--branches-pane-width', `${logPaneWidths.left}px`);
    else workspace.style.removeProperty('--branches-pane-width');
    if (Number.isFinite(logPaneWidths.right)) workspace.style.setProperty('--commit-pane-width', `${logPaneWidths.right}px`);
    else workspace.style.removeProperty('--commit-pane-width');
  }

  function beginPaneResize(event, resizer) {
    if (event.button !== 0) return;
    const workspace = byId('logTab');
    const side = resizer.dataset.resizer;
    if (!workspace || !side) return;
    const workspaceRect = workspace.getBoundingClientRect();
    activePaneResize = {
      side,
      startX: event.clientX,
      containerWidth: workspaceRect.width,
      left: byId('branchTree').closest('.branches-pane').getBoundingClientRect().width,
      right: byId('commitDetails').closest('.commit-pane').getBoundingClientRect().width,
      resizer,
    };
    resizer.setPointerCapture?.(event.pointerId);
    resizer.classList.add('dragging');
    document.body.classList.add('resizing-panes');
    event.preventDefault();
  }

  function resizePane(event) {
    if (!activePaneResize) return;
    const delta = event.clientX - activePaneResize.startX;
    const requested = activePaneResize.side === 'left'
      ? activePaneResize.left + delta
      : activePaneResize.right - delta;
    logPaneWidths = window.SmartGitLogGraph.resizeLogPanes(
      activePaneResize.containerWidth,
      activePaneResize.left,
      activePaneResize.right,
      activePaneResize.side,
      requested,
    );
    applyLogPaneWidths();
  }

  function finishPaneResize() {
    if (!activePaneResize) return;
    activePaneResize.resizer.classList.remove('dragging');
    document.body.classList.remove('resizing-panes');
    activePaneResize = undefined;
    saveUiState();
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
      const selection = selectionForSource(source);
      const conflicted = selection.filter(({ change }) => change.conflicted);
      const ordinary = selection.filter(({ change }) => !change.conflicted);
      const hasStaged = ordinary.some(({ change }) => change.hasStagedChange);
      const hasWorking = ordinary.some(({ change }) => change.hasWorkingTreeChange);
      const canRollback = ordinary.some(({ change }) => change.hasWorkingTreeChange || change.hasStagedChange);
      const canDelete = selection.some(({ change }) => change.kind !== 'deleted');
      const items = [
        ...(selection.length > 1 ? [{ label: `${selection.length} files selected`, heading: true }, separator()] : []),
        { label: 'Show Diff', action: 'openDiff' },
        { label: 'Show Diff in a New Tab', action: 'openDiffNew' },
        { label: 'Jump to Source', action: 'openSource' },
        { label: 'Copy Path/Reference…', action: 'copyPath' },
        separator(),
      ];
      if (conflicted.length) {
        items.push(
          { label: 'Resolve Conflicts', heading: true },
          { label: '  Open Conflict Resolver', action: 'openConflictResolver' },
          { label: '  Open Smart Git Merge Editor', action: 'openMerge' },
          { label: '  Accept Ours', action: 'useOurs' },
          { label: '  Accept Theirs', action: 'useTheirs' },
          { label: '  Mark Resolved', action: 'markResolved' },
        );
      }
      if (ordinary.length) {
        if (hasWorking) items.push({ label: 'Stage', action: 'stage' });
        if (hasStaged) items.push({ label: 'Unstage', action: 'unstage' });
        if (canRollback) items.push({ label: 'Rollback…', action: 'discard', danger: true });
      }
      if (canDelete) items.push({ label: 'Delete Files…', action: 'deleteFiles', danger: true, shortcut: 'Delete' });
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
      const checkedOut = source.dataset.checkedOut === 'true';
      return [
        { label: 'Filter Log by Branch', action: 'setLogRef', icon: '⑂' },
        ...(!remote && !checkedOut ? [{ label: 'Checkout', action: 'switchBranch', icon: '↪' }] : []),
        { label: 'New Branch from Selected…', action: 'newBranchFromRef', icon: '⑂' },
        { label: 'Copy Branch Name', action: 'copyBranch', icon: '⧉' },
        ...(!remote && !current && !checkedOut ? [separator(), { label: 'Delete Branch…', action: 'deleteBranch', danger: true, icon: '⌫' }] : []),
      ];
    }
    if (kind === 'commit') {
      const commit = visibleCommits.find((entry) => entry.hash === source.dataset.hash);
      const parent = visibleCommits.find((entry) => commit?.parents?.[0] === entry.hash)?.hash;
      const child = visibleCommits.find((entry) => entry.parents?.includes(source.dataset.hash));
      return [
        { label: `${commit?.shortHash || ''}  ${commit?.subject || 'Commit'}`, heading: true },
        separator(),
        { label: 'Copy Revision Number', action: 'copyHash', icon: '⧉' },
        { label: 'Show Commit Details', action: 'showCommit', icon: 'ⓘ' },
        { label: 'Cherry-Pick…', action: 'cherryPick', icon: '◉' },
        separator(),
        { label: 'Checkout Revision…', action: 'checkoutCommit', icon: '↪' },
        { label: 'Compare with Local', action: 'compareWithLocal', icon: '⇄' },
        separator(),
        { label: 'Reset Current Branch to Here…', action: 'resetToCommit', danger: true, icon: '↶' },
        { label: 'Revert Commit…', action: 'revertCommit', icon: '↩' },
        separator(),
        { label: 'New Branch…', action: 'branchFromCommit', icon: '⑂' },
        { label: 'New Tag…', action: 'tagFromCommit', icon: '◇' },
        ...(parent || child ? [
          separator(),
          ...(child ? [{ label: 'Go to Child Commit', action: 'navigateCommit', hash: child.hash, icon: '←' }] : []),
          ...(parent ? [{ label: 'Go to Parent Commit', action: 'navigateCommit', hash: parent, icon: '→' }] : []),
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
      const button = element('button', `context-item${item.danger ? ' danger' : ''}${item.heading ? ' heading' : ''}`);
      button.setAttribute('role', 'menuitem');
      button.append(
        element('span', 'context-icon', item.icon || ''),
        element('span', 'context-label', item.label),
      );
      if (item.shortcut) button.append(element('span', 'context-shortcut', item.shortcut));
      if (item.heading) {
        button.disabled = true;
      } else {
        Object.entries(source.dataset).forEach(([key, value]) => { button.dataset[key] = value; });
        button.dataset.action = item.action;
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
    if (!hash || !visibleCommits.some((commit) => commit.hash === hash)) return;
    if (selectedCommit !== hash) clearCommitDetails();
    selectedCommit = hash;
    document.querySelectorAll('.commit-row').forEach((row) => row.classList.toggle('selected', row.dataset.hash === hash));
    post('showCommit', { hash });
    document.querySelector(`.commit-row[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function dispatch(action, target, event) {
    const path = target.dataset.path;
    const hash = target.dataset.hash || selectedCommit;
    switch (action) {
      case 'refresh': case 'fetch': case 'pull': case 'push': case 'stageAll': case 'unstageAll': case 'continueOperation': case 'abortOperation':
        post(action); break;
      case 'stage': case 'unstage': case 'discard': case 'deleteFiles': case 'markResolved': case 'useOurs': case 'useTheirs': case 'openMerge': {
        const paths = target.dataset.conflictPath
          ? [target.dataset.conflictPath]
          : selectedPathsForAction(action, target);
        if (paths.length) post(action, { paths });
        break;
      }
      case 'previewDiff':
        if (path) selectChange(
          { path, mode: target.dataset.mode, staged: target.dataset.staged === 'true', conflicted: target.dataset.conflicted === 'true' },
          { range: Boolean(event?.shiftKey), toggle: Boolean(event?.metaKey || event?.ctrlKey), additive: Boolean(event?.metaKey || event?.ctrlKey) },
        );
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
      case 'toggleConflictGroup': {
        const groupId = target.dataset.groupId;
        if (!groupId) break;
        if (collapsedChangeGroups.has(groupId)) collapsedChangeGroups.delete(groupId);
        else collapsedChangeGroups.add(groupId);
        saveUiState();
        renderChanges();
        break;
      }
      case 'openConflictResolver':
        if (state.conflicts?.files?.length) {
          conflictViewOpen = true;
          selectedConflictPath = state.conflicts.files[0]?.path;
          renderConflictResolver();
          setTab(activeTab);
        }
        break;
      case 'closeConflictResolver':
        conflictViewOpen = false;
        setTab('changes');
        break;
      case 'resolveConflictFile':
        if (target.dataset.conflictPath) {
          selectedConflictPath = target.dataset.conflictPath;
          renderConflictResolver();
          post('openMerge', { paths: [selectedConflictPath] });
        }
        break;
      case 'resolveManually': {
        const conflictPath = selectedConflictPath || state.conflicts?.files?.[0]?.path;
        if (conflictPath) post('openMerge', { paths: [conflictPath] });
        break;
      }
      case 'resolveSimpleConflicts': {
        const paths = (state.conflicts?.files || []).filter((conflict) => conflict.simple).map((conflict) => conflict.path);
        if (paths.length) post('resolveSimpleConflicts', { paths });
        break;
      }
      case 'finishConflicts':
        if (!(state.conflicts?.files?.length) && state.operation) post('continueOperation');
        break;
      case 'toggleBranchGroup': {
        const groupId = target.dataset.branchGroup;
        if (!groupId) break;
        if (collapsedBranchGroups.has(groupId)) collapsedBranchGroups.delete(groupId);
        else collapsedBranchGroups.add(groupId);
        saveUiState();
        renderBranches();
        byId('branchTree').querySelector(`[data-branch-group="${CSS.escape(groupId)}"]`)?.focus({ preventScroll: true });
        break;
      }
      case 'setLogRef': {
        const ref = target.dataset.logRef ?? '';
        if (logRef === ref) break;
        applyLogFilters(ref, logAuthor);
        if (target.closest('#branchTree')) {
          byId('branchTree').querySelector(`[data-log-ref="${CSS.escape(ref)}"]`)?.focus({ preventScroll: true });
        }
        break;
      }
      case 'openLogFilter':
        openLogFilter(target.dataset.filter, target);
        break;
      case 'chooseLogFilter': {
        const kind = openLogFilterType;
        closeLogFilter(true);
        if (kind === 'branch') applyLogFilters(target.dataset.logRef ?? '', logAuthor);
        if (kind === 'user') applyLogFilters(logRef, logAuthors?.[Number(target.dataset.authorIndex)]);
        break;
      }
      case 'clearLogFilters':
        byId('logFilter').value = '';
        applyLogFilters('', undefined);
        byId('logFilter').focus();
        break;
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
      case 'stageSelected': {
        const paths = selectedPathsForAction('stage', byId('diffToolbar'));
        if (paths.length) post('stage', { paths });
        break;
      }
      case 'unstageSelected': {
        const paths = selectedPathsForAction('unstage', byId('diffToolbar'));
        if (paths.length) post('unstage', { paths });
        break;
      }
      case 'discardSelected': {
        const paths = selectedPathsForAction('discard', byId('diffToolbar'));
        if (paths.length) post('discard', { paths });
        break;
      }
      case 'toggleDiffExpanded': {
        const expanded = byId('changesTab').classList.toggle('diff-expanded');
        byId('toggleDiffExpanded').textContent = expanded ? '↙' : '⛶';
        byId('toggleDiffExpanded').title = expanded ? 'Restore file list' : 'Maximize diff preview';
        break;
      }
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
      case 'toggleGraphNode':
        if (hash && visibleCommits.some((commit) => commit.hash === hash)) {
          expandedCommit = expandedCommit === hash ? undefined : hash;
          renderLog();
          if (expandedCommit) {
            selectCommit(hash);
            byId('logList').querySelector('.graph-details')?.scrollIntoView({ block: 'nearest' });
          }
          byId('logList').querySelector(`.graph-node-trigger[data-hash="${CSS.escape(hash)}"]`)?.focus({ preventScroll: true });
        }
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

  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#logFilterPopover, [data-action="openLogFilter"]')) closeLogFilter();
    const resizer = event.target.closest('.pane-resizer');
    if (resizer) beginPaneResize(event, resizer);
    const menu = byId('contextMenu');
    if (!menu.classList.contains('hidden')
      && !event.target.closest('#contextMenu')
      && !event.target.closest('[data-context-trigger]')) {
      closeContextMenu();
    }
  }, true);

  document.addEventListener('pointermove', resizePane);
  document.addEventListener('pointerup', finishPaneResize);
  document.addEventListener('pointercancel', finishPaneResize);

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
    dispatch(target.dataset.action, target, event);
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
      const descriptor = {
        path: source.dataset.path,
        mode: source.dataset.mode,
        staged: source.dataset.staged === 'true',
        conflicted: source.dataset.conflicted === 'true',
      };
      if (selectedChangeKeys.has(changeKey(descriptor))) activateSelectedChange(descriptor);
      else selectChange(descriptor);
    } else if (source.dataset.context === 'commit' && source.dataset.hash) {
      selectCommit(source.dataset.hash);
    }
    openContextMenu(source, event.clientX, event.clientY);
  });

  document.addEventListener('dblclick', (event) => {
    const resizer = event.target.closest('.pane-resizer');
    if (resizer) {
      logPaneWidths = { ...logPaneWidths, [resizer.dataset.resizer]: undefined };
      applyLogPaneWidths();
      saveUiState();
      return;
    }
    const row = event.target.closest('.file-row');
    if (!row?.dataset.path) return;
    if (row.dataset.conflicted === 'true') post('openMerge', { paths: [row.dataset.path] });
    else post('openDiff', { path: row.dataset.path, staged: row.dataset.staged === 'true' });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openLogFilterType) {
      event.preventDefault();
      closeLogFilter(true);
      return;
    }
    if (openLogFilterType && event.target.closest('#logFilterPopover')) {
      const options = [...byId('logFilterChoices').querySelectorAll('button')];
      const index = options.indexOf(event.target);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? options[index + 1] : options[index - 1];
        (next || byId('logChoiceSearch')).focus();
      } else if (event.key === 'Enter' && event.target === byId('logChoiceSearch')) {
        event.preventDefault();
        options[0]?.click();
      }
      return;
    }
    const resizer = event.target.closest('.pane-resizer');
    if (resizer && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const workspace = byId('logTab');
      const side = resizer.dataset.resizer;
      const currentLeft = byId('branchTree').closest('.branches-pane').getBoundingClientRect().width;
      const currentRight = byId('commitDetails').closest('.commit-pane').getBoundingClientRect().width;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const step = event.shiftKey ? 48 : 16;
      const requested = side === 'left'
        ? currentLeft + direction * step
        : currentRight - direction * step;
      logPaneWidths = window.SmartGitLogGraph.resizeLogPanes(
        workspace.getBoundingClientRect().width,
        currentLeft,
        currentRight,
        side,
        requested,
      );
      applyLogPaneWidths();
      saveUiState();
      return;
    }
    const branchGroup = event.target.closest('[data-branch-group]');
    if (branchGroup && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !byId('branchFilter').value.trim()) {
      event.preventDefault();
      const shouldExpand = event.key === 'ArrowRight';
      if ((branchGroup.getAttribute('aria-expanded') === 'true') !== shouldExpand) branchGroup.click();
      return;
    }
    if (event.key === 'Escape') {
      closeContextMenu();
      return;
    }
    const focusedFile = document.activeElement?.closest?.('.file-row');
    if (
      activeTab === 'changes'
      && (event.key === 'Delete' || event.key === 'Backspace')
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && focusedFile
    ) {
      event.preventDefault();
      const paths = selectedPathsForAction('deleteFiles', focusedFile);
      if (paths.length) post('deleteFiles', { paths });
      return;
    }
    const target = event.target.closest('[data-action]');
    if ((event.key === 'Enter' || event.key === ' ') && target && !target.matches('button')) {
      event.preventDefault();
      dispatch(target.dataset.action, target, event);
    }
  });

  window.addEventListener('blur', () => {
    closeContextMenu();
    closeLogFilter();
    highlightLogTrace();
  });
  window.addEventListener('resize', () => {
    if (openLogFilterType) {
      positionLogFilter(byId(openLogFilterType === 'branch' ? 'logBranchButton' : 'logUserButton'));
    }
  });
  document.addEventListener('scroll', closeContextMenu, true);

  byId('repository').addEventListener('change', (event) => post('selectRepository', { root: event.target.value }));
  byId('logFilter').addEventListener('input', () => {
    updateLogFilterButtons();
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(renderLog, 90);
  });
  byId('branchFilter').addEventListener('input', renderBranches);
  byId('logChoiceSearch').addEventListener('input', renderLogFilterChoices);
  const logTipAt = (target) => target instanceof Element ? target.closest('[data-log-tip]')?.dataset.logTip : undefined;
  byId('logTab').addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'touch') highlightLogTrace(logTipAt(event.target));
  });
  byId('logTab').addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'touch') highlightLogTrace(logTipAt(event.relatedTarget));
  });
  byId('logTab').addEventListener('focusin', (event) => highlightLogTrace(logTipAt(event.target)));
  byId('logTab').addEventListener('focusout', (event) => highlightLogTrace(logTipAt(event.relatedTarget)));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      const rootChanged = state.activeRoot !== message.state.activeRoot;
      state = message.state;
      if (rootChanged) {
        closeLogFilter();
        logRef = '';
        logAuthor = undefined;
        logAuthors = undefined;
        logAuthorsError = false;
        selectedCommit = undefined;
        expandedCommit = undefined;
        hoveredLogTip = undefined;
        clearCommitDetails();
        byId('branchFilter').value = '';
        byId('logFilter').value = '';
      } else if (logRef && (logRef === 'HEAD'
        ? !headChoice()
        : !logRefGroups().some((group) => group.choices.some((choice) => choice.ref === logRef)))) {
        logRef = '';
        filteredCommits = undefined;
      }
      if (activeTab === 'log') requestLog(true);
      fileIcons = message.fileIcons || {};
      previewRequestKey = undefined;
      render();
    } else if (message.type === 'loading') {
      show(byId('loading'), message.value && !state.status);
    } else if (message.type === 'diffPreview') {
      if (!selectedChange || message.path === selectedChange.path) renderDiffPreview(message);
    } else if (message.type === 'logResult') {
      if (message.root !== state.activeRoot || message.requestId !== logRequestId) return;
      filteredCommits = message.commits;
      logError = message.error || '';
      renderLog();
    } else if (message.type === 'logAuthors') {
      if (message.root !== state.activeRoot || message.requestId !== logAuthorRequestId) return;
      logAuthors = message.authors;
      logAuthorsError = Boolean(message.error);
      renderLogFilterChoices();
    } else if (message.type === 'commitDetails') {
      if (message.root !== state.activeRoot || message.hash !== selectedCommit) return;
      fileIcons = { ...fileIcons, ...(message.fileIcons || {}) };
      byId('detailsTitle').textContent = message.title;
      byId('detailsBody').textContent = message.details;
      renderCommitFiles(message.files || [], message.hash);
      show(byId('commitEmpty'), false);
      show(byId('commitDetails'), true);
    } else if (message.type === 'appendCommit') {
      if (message.commit && !state.commits.some((commit) => commit.hash === message.commit.hash)) {
        state.commits.push(message.commit);
        renderLog();
      }
    } else if (message.type === 'revealCommit') {
      byId('logFilter').value = '';
      applyLogFilters('', undefined);
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
