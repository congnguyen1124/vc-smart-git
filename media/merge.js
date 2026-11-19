(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const {
    scanConflicts, createDraft, isPending, canIgnoreSide, canResolveSimple, resolveSimpleDraft,
    resolveBlock, editDraft, draftRegions,
    splitLines, changeColors, sourceRanges, createPaneLayout, mapRow, paneRow,
  } = globalThis.SmartGitMerge;
  const byId = (id) => document.getElementById(id);
  const editor = byId('result');
  const show = (id, visible) => byId(id).classList.toggle('hidden', !visible);
  const setText = (id, text) => { byId(id).textContent = text; };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let file;
  let draft;
  let initialDraft;
  let regions;
  let pending = [];
  let hasMarkers = false;
  let inputSelection;
  let activeIndex = 0;
  let showRevision = false;
  let showBase = false;
  let busy = false;
  let resolvedNotice = '';
  let revisions;
  let comparedText;
  let resultLines;
  let resultColors;
  let rowHeight = 21;
  const undo = [];
  const redo = [];
  const sides = ['ours', 'theirs'].map((side) => ({
    side,
    scroll: byId(`${side}Code`),
    sheet: element('div', 'code-sheet'),
    rows: element('div', 'code-rows'),
  }));
  const paneFor = new Map(sides.map((pane) => [pane.scroll, pane]));
  const scrollPositions = new Map();
  const changeLabels = { added: 'Added', removed: 'Removed', modified: 'Replaced' };

  function appendCode(line, text) {
    if (text.length > 2000) {
      line.textContent = text;
      return;
    }
    const tokens = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|\b(?:async|await|class|const|export|from|function|if|import|let|new|return|throw|type|var|void|while)\b|\b(?:\d+(?:\.\d+)?|true|false|null|undefined)\b)/g;
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      line.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      const type = token.startsWith('//') ? 'comment' : /^['"`]/.test(token) ? 'string'
        : /^(true|false|null|undefined|\d)/.test(token) ? 'literal' : 'keyword';
      line.append(element('span', `token-${type}`, token));
      cursor = match.index + token.length;
    }
    line.append(document.createTextNode(text.slice(cursor)));
  }

  function loadRevisions() {
    const base = file.base.text !== undefined || !file.base.present ? splitLines(file.base.text) : undefined;
    const working = (file.working.text ?? '').split('\n');
    const conflicts = draft.blocks.map(({ original }) => original);
    const entries = ['ours', 'theirs', 'base'].map((key) => {
      const version = file[key];
      const lines = splitLines(version.text);
      const columns = lines.reduce((width, line) => Math.max(width, line.replaceAll('\t', '    ').length), 0);
      const colors = version.text !== undefined || !version.present ? changeColors(base, lines) : changeColors();
      const ranges = conflicts.length ? sourceRanges(working, lines, conflicts) : [];
      return [key, { ...version, lines, columns, colors, ranges }];
    });
    conflicts.forEach((_, index) => {
      const ranges = entries.map(([, revision]) => revision.ranges[index]);
      const minimum = Math.max(1, ...ranges.map(({ start, end }) => end - start));
      for (const range of ranges) range.minimum = minimum;
    });
    return Object.fromEntries(entries);
  }

  function updateLayouts() {
    const edited = comparedText !== draft.text;
    if (edited) {
      comparedText = draft.text;
      resultLines = draft.text.split('\n');
      regions = draftRegions(draft);
      const base = revisions.base.text !== undefined || !revisions.base.present ? revisions.base.lines : undefined;
      resultColors = changeColors(base, splitLines(draft.text));
    }
    rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
    for (const pane of sides) {
      const revision = revisions[pane.side === 'ours' && showBase ? 'base' : pane.side];
      const pad = !showRevision && file.working.text !== undefined && (revision.text !== undefined || !revision.present);
      if (edited || pane.revision !== revision || pane.pad !== pad) {
        pane.revision = revision;
        pane.pad = pad;
        pane.layout = createPaneLayout(resultLines, revision.lines, pad, regions, revision.ranges);
        pane.sheet.style.height = `${pane.layout.height * rowHeight}px`;
        pane.sheet.style.setProperty('--columns', String(revision.columns));
        pane.note.textContent = revision.text === undefined
          ? revision.note || 'This revision has no file at this path.'
          : revision.lines.length ? '' : 'This revision is an empty file.';
        pane.scroll.classList.toggle('has-merge-rail', !showRevision && !(pane.side === 'ours' && showBase));
      }
      // When a side deletes its entire file there is still a gap to scroll through.
      pane.note.hidden = !pane.note.textContent;
    }
  }

  function blockAt(row) {
    let low = 0;
    let high = regions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const { startLine, endLine } = regions[mid];
      if (Math.max(startLine + 1, endLine) <= row) low = mid + 1;
      else high = mid;
    }
    return regions[low]?.startLine <= row ? low : -1;
  }

  function applyChangeStyle(node, kind) {
    if (!kind) return;
    node.classList.add(`diff-${kind}`);
    node.title = changeLabels[kind];
  }

  function renderCode(pane, force) {
    const { scroll, layout, rows, revision, side } = pane;
    if (!layout) return;
    const first = Math.max(0, Math.floor(scroll.scrollTop / rowHeight) - 3);
    const last = Math.min(layout.height + 1, first + Math.ceil(scroll.clientHeight / rowHeight) + 8);
    if (!force && pane.first === first && pane.last === last) return;
    pane.first = first;
    pane.last = last;
    const hasRail = scroll.classList.contains('has-merge-rail');
    const fragment = document.createDocumentFragment();
    for (let row = first; row < last; row += 1) {
      const position = paneRow(layout, row);
      const source = position?.source ?? revision.lines.length;
      const block = hasRail && draft.blocks[position?.conflict];
      const processed = Boolean(block && block[side] !== null);
      const gap = position?.gap;
      const removed = revision.colors.removed.has(source) && paneRow(layout, row - 1)?.source !== source;
      if (!position && !removed) continue;
      const trailingBlank = !block && row === layout.height - 1 && resultLines.at(-1) === '';
      const line = element('div', `code-line${gap && !trailingBlank ? ' diff-gap' : ''}`);
      if (!processed) {
        applyChangeStyle(line, gap && revision.colors.removed.has(source) ? 'removed' : !gap && revision.colors.kinds[source]);
        if (block && !line.title) line.classList.add('diff-conflict');
      }
      if (removed) {
        const count = revision.colors.removed.get(source);
        line.classList.add('deletion-boundary');
        line.title = `${count} ${count === 1 ? 'line' : 'lines'} removed`;
      }
      if (processed && position.first) {
        line.classList.add('processed-boundary');
        line.title = block[side] === 'ignored' ? 'Ignored for this conflict' : 'Processed for this conflict';
      }
      line.append(element('span', 'line-number', position && !gap ? String(source + 1) : ''));
      const contents = element('span', 'code-text');
      if (position && !gap) appendCode(contents, revision.lines[source]);
      line.append(contents);
      if (hasRail) {
        const rail = element('span', 'merge-rail');
        if (block && position.first && !processed) appendBlockActions(rail, side, block, position.conflict);
        line.append(rail);
      }
      fragment.append(line);
    }
    rows.style.top = `${first * rowHeight}px`;
    const focused = rows.contains(document.activeElement) ? { ...document.activeElement.dataset } : undefined;
    rows.replaceChildren(fragment);
    if (focused) {
      const control = rows.querySelector(`[data-merge-action="${focused.mergeAction}"][data-merge-conflict="${focused.mergeConflict}"]:enabled`);
      if (control) control.focus({ preventScroll: true });
    }
  }

  function appendBlockActions(rail, side, block, index) {
    const left = side === 'ours';
    const label = left ? 'Current' : 'Incoming';
    const button = (action, icon, title, disabled) => {
      const control = element('button', `merge-inline merge-inline-${action}`, icon);
      control.type = 'button';
      control.dataset.mergeAction = action;
      control.dataset.mergeSide = side;
      control.dataset.mergeConflict = String(index);
      control.setAttribute('aria-label', title);
      control.title = title;
      control.disabled = disabled;
      return control;
    };
    const append = block.manual || block[left ? 'theirs' : 'ours'] === 'accepted';
    const apply = button('take', append ? (left ? '↳' : '↲') : (left ? '»' : '«'),
      `${append ? 'Append' : 'Accept'} ${label} in Result`, busy);
    const canIgnore = canIgnoreSide(block, side);
    const ignore = button('ignore', '×', `Ignore ${label} for this conflict`, !canIgnore || busy);
    if (!canIgnore) ignore.title = 'Base unavailable. Edit Result or accept this side.';
    rail.append(...(left ? [ignore, apply] : [apply, ignore]));
  }

  function renderGutter() {
    if (file?.working.text === undefined) return;
    const first = Math.max(0, Math.floor(editor.scrollTop / rowHeight));
    const last = Math.min(resultLines.length, first + Math.ceil(editor.clientHeight / rowHeight) + 1);
    const offset = first * rowHeight - editor.scrollTop;
    const gutter = byId('gutter');
    const highlights = byId('resultHighlights');
    gutter.style.setProperty('--offset', `${offset}px`);
    highlights.style.setProperty('--offset', `${offset}px`);
    const numbers = [];
    const backgrounds = [];
    for (let line = first; line < last; line += 1) {
      const index = blockAt(line);
      const block = draft.blocks[index];
      const unresolved = block && isPending(block);
      const number = element('div', unresolved ? (index === activeIndex ? 'active-marker' : 'marker') : '', String(line + 1));
      const background = element('div', '');
      const kind = resultColors.kinds[line];
      applyChangeStyle(number, kind);
      applyChangeStyle(background, kind);
      const removed = resultColors.removed.has(line);
      if (unresolved && !kind && !removed) {
        if (regions[index].endLine > line) background.classList.add('diff-conflict');
        else background.classList.add('conflict-boundary');
      }
      if (removed) {
        number.classList.add('deletion-boundary');
        background.classList.add('deletion-boundary');
      }
      numbers.push(number);
      backgrounds.push(background);
    }
    gutter.replaceChildren(...numbers);
    highlights.replaceChildren(...backgrounds);
  }

  function syncScroll(source = editor, force = false) {
    if (file.working.text !== undefined) {
      const pane = paneFor.get(source);
      const row = source.scrollTop / rowHeight;
      const conflict = pane ? paneRow(pane.layout, Math.floor(row))?.conflict : undefined;
      const resultRow = pane ? mapRow(pane.layout, row, true) : row;
      for (const target of [editor, ...sides.map(({ scroll }) => scroll)]) {
        if (target === source) continue;
        const other = paneFor.get(target);
        const targetBlock = other?.layout.conflicts[conflict];
        const targetRow = targetBlock ? targetBlock.start + row - pane.layout.conflicts[conflict].start
          : other ? mapRow(other.layout, resultRow, false) : resultRow;
        target.scrollTop = targetRow * rowHeight;
        scrollPositions.set(target, target.scrollTop);
      }
      renderGutter();
    }
    for (const side of sides) renderCode(side, force);
  }

  function onScroll(event) {
    if (!file) return;
    const source = event.currentTarget;
    if (scrollPositions.get(source) === source.scrollTop) return;
    scrollPositions.set(source, source.scrollTop);
    syncScroll(source);
  }

  function goToBlock() {
    const block = regions[activeIndex];
    if (!block) return;
    editor.scrollTop = Math.max(0, (block.startLine - 5) * rowHeight);
    scrollPositions.set(editor, editor.scrollTop);
    syncScroll();
  }

  function render() {
    if (!file) return;
    if (comparedText !== draft.text) {
      const markers = scanConflicts(draft.text, file.markerSize);
      hasMarkers = markers.malformed || markers.blocks.length > 0;
    }
    pending = draft.blocks.flatMap((block, index) => isPending(block) ? [index] : []);
    const count = pending.length;
    if (count && !pending.includes(activeIndex)) activeIndex = pending.find((index) => index > activeIndex) ?? pending[0];
    const current = count ? draft.blocks[activeIndex] : undefined;
    const simpleCount = draft.blocks.filter(canResolveSimple).length;
    const editable = file.working.text !== undefined;
    editor.readOnly = busy || !editable;
    const ready = editable && !count && !hasMarkers;
    const title = !editable ? 'Choose a revision' : hasMarkers ? 'Check conflict markers'
      : count ? `${count} unresolved` : 'Ready to stage';
    setText('progress', title);
    byId('progress').className = `status ${ready ? 'resolved' : 'unresolved'}`;
    setText('position', count ? `Conflict ${pending.indexOf(activeIndex) + 1} of ${count}` : 'No unresolved conflicts');
    const oursLabel = file.oursLabel && file.oursLabel !== '(detached)' ? file.oursLabel : 'Git index · Stage 2';
    const theirsLabel = file.theirsLabel || 'Git index · Stage 3';
    setText('oursName', showBase ? 'Base' : file.operation === 'rebase' ? 'Rebase target' : 'Current');
    setText('oursMeta', showBase ? 'Common ancestor' : oursLabel);
    setText('theirsMeta', theirsLabel);
    setText('resultMeta', draft !== initialDraft ? 'Edited draft' : 'Editable draft');
    const oursAppend = current?.manual || current?.theirs === 'accepted';
    const theirsAppend = current?.manual || current?.ours === 'accepted';
    setText('useOurs', oursAppend ? 'Append Current →' : 'Accept Current →');
    setText('useTheirs', theirsAppend ? '← Append Incoming' : '← Accept Incoming');
    setText('footerHelp', file.working.note || (hasMarkers ? 'Remove the Git conflict markers in Result before staging.'
      : !count ? 'All conflicts processed. Review Result, then apply and stage.'
        : resolvedNotice || (current.base === undefined && !current.manual && current.ours !== 'accepted' && current.theirs !== 'accepted'
          ? 'Base is unavailable for this conflict. Choose a side or edit Result.'
          : 'Accept or ignore each side. Accepting the second side appends its changes.')));
    const disabled = {
      previous: count < 2, next: count < 2, toggleRevision: !editable, toggleBase: !file.base.present,
      resolveSimple: !editable || !simpleCount,
      useOurs: current?.ours !== null, useTheirs: current?.theirs !== null,
      useBase: current?.base === undefined, keepResult: !current?.manual,
      undoChoice: !undo.length, apply: !ready,
      acceptOurs: false, acceptTheirs: false,
    };
    for (const [id, unavailable] of Object.entries(disabled)) byId(id).disabled = busy || unavailable;
    byId('resolveSimple').title = simpleCount
      ? `Resolve ${simpleCount} simple conflict${simpleCount === 1 ? '' : 's'} in Result`
      : 'No simple conflicts available in this file';
    byId('close').disabled = busy;
    byId('toggleRevision').setAttribute('aria-pressed', String(showRevision));
    byId('toggleBase').setAttribute('aria-pressed', String(showBase));
    setText('toggleRevision', showRevision ? 'Align changes' : 'Full revisions');
    setText('toggleBase', showBase ? 'Show current' : 'Show base');
    setText('acceptOurs', file.ours.present ? 'Entire Current…' : 'Accept Deletion…');
    setText('acceptTheirs', file.theirs.present ? 'Entire Incoming…' : 'Accept Deletion…');
    show('useBase', current?.base !== undefined);
    show('keepResult', Boolean(current?.manual));
    updateLayouts();
    syncScroll(editor, true);
  }

  function selection() {
    return { start: editor.selectionStart, end: editor.selectionEnd };
  }

  function writeResult(text, position) {
    const top = editor.scrollTop;
    const left = editor.scrollLeft;
    editor.value = text;
    editor.setSelectionRange(position.start, position.end);
    editor.scrollTop = top;
    editor.scrollLeft = left;
  }

  function update(next, index = activeIndex, notice = '', previousSelection = selection()) {
    if (next === draft) return;
    undo.push({ draft, index: activeIndex, selection: previousSelection });
    if (undo.length > 20) undo.shift();
    redo.length = 0;
    draft = next;
    activeIndex = index;
    resolvedNotice = notice;
    if (editor.value !== draft.text) writeResult(draft.text, previousSelection);
    render();
  }

  function restoreHistory(from, to) {
    if (busy || !from.length) return;
    const previous = from.pop();
    to.push({ draft, index: activeIndex, selection: selection() });
    draft = previous.draft;
    activeIndex = previous.index;
    resolvedNotice = '';
    writeResult(draft.text, previous.selection);
    render();
  }

  function resolveSimple() {
    if (byId('resolveSimple').disabled) return;
    const { draft: nextDraft, count } = resolveSimpleDraft(draft);
    update(nextDraft, activeIndex, `Resolved ${count} simple conflict${count === 1 ? '' : 's'} in Result.`);
    const next = !byId('apply').disabled ? byId('apply') : byId('undoChoice');
    next.focus({ preventScroll: true });
  }

  function inlineAction(event) {
    const button = event.target.closest('[data-merge-action]');
    if (!button || busy) return;
    const index = Number(button.dataset.mergeConflict);
    const side = button.dataset.mergeSide;
    update(resolveBlock(draft, index, button.dataset.mergeAction, side), index);
    const next = document.querySelector(`[data-merge-conflict="${index}"][data-merge-action="take"]:enabled`);
    (next || (!byId('apply').disabled ? byId('apply') : byId('undoChoice'))).focus({ preventScroll: true });
  }

  function move(offset) {
    if (pending.length < 2) return;
    activeIndex = pending[(pending.indexOf(activeIndex) + offset + pending.length) % pending.length];
    render();
    goToBlock();
  }

  function submit(type, data) {
    if (busy) return;
    busy = true;
    show('error', false);
    render();
    vscode.postMessage({ type, ...data });
  }

  byId('previous').onclick = () => move(-1);
  byId('next').onclick = () => move(1);
  byId('resolveSimple').onclick = resolveSimple;
  byId('useOurs').onclick = () => update(resolveBlock(draft, activeIndex, 'take', 'ours'));
  byId('useTheirs').onclick = () => update(resolveBlock(draft, activeIndex, 'take', 'theirs'));
  byId('keepResult').onclick = () => update(resolveBlock(draft, activeIndex, 'keep'));
  byId('useBase').onclick = () => update(resolveBlock(draft, activeIndex, 'base'));
  byId('acceptOurs').onclick = () => submit('acceptSide', { side: 'ours' });
  byId('acceptTheirs').onclick = () => submit('acceptSide', { side: 'theirs' });
  byId('close').onclick = () => submit('close', { dirty: draft !== initialDraft });
  byId('apply').onclick = () => submit('apply', { text: editor.value });
  byId('undoChoice').onclick = () => restoreHistory(undo, redo);
  byId('toggleRevision').onclick = () => { showRevision = !showRevision; render(); };
  byId('toggleBase').onclick = () => { showBase = !showBase; render(); };
  const resize = new ResizeObserver(() => {
    if (file) syncScroll(editor, true);
  });
  for (const pane of sides) {
    pane.note = element('p', 'revision-note muted');
    pane.sheet.append(pane.rows);
    pane.scroll.append(pane.sheet, pane.note);
    pane.scroll.addEventListener('click', inlineAction);
    pane.scroll.addEventListener('scroll', onScroll, { passive: true });
    resize.observe(pane.scroll);
  }
  editor.addEventListener('beforeinput', (event) => {
    if (event.cancelable && (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')) {
      event.preventDefault();
      if (event.inputType === 'historyUndo') restoreHistory(undo, redo);
      else restoreHistory(redo, undo);
      return;
    }
    inputSelection = selection();
  });
  editor.addEventListener('input', () => {
    const before = inputSelection;
    const next = editDraft(draft, editor.value, before, editor.selectionEnd);
    inputSelection = undefined;
    const index = next.blocks.findIndex((block) => isPending(block) && block.start <= editor.selectionStart &&
      block.end >= editor.selectionStart);
    update(next, index >= 0 ? index : activeIndex, '', before);
  });
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    const reverse = key === 'y' || event.shiftKey;
    event.preventDefault();
    if (reverse) restoreHistory(redo, undo);
    else restoreHistory(undo, redo);
  });
  editor.addEventListener('scroll', onScroll, { passive: true });
  resize.observe(editor);
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'file') {
      file = data;
      initialDraft = createDraft(file.working.text ?? '', file.markerSize,
        new Map(file.conflictBases ?? []), !file.base.present);
      draft = initialDraft;
      revisions = loadRevisions();
      comparedText = undefined;
      setText('fileName', file.path.split('/').pop());
      setText('fileLocation', `${file.repository} / ${file.path}`);
      byId('fileLocation').title = byId('fileLocation').textContent;
      editor.value = draft.text;
      const start = draft.blocks[0]?.start ?? 0;
      editor.setSelectionRange(start, start);
      editor.readOnly = file.working.text === undefined;
      setText('resultNote', file.working.note || '');
      show('editorBody', !editor.readOnly);
      show('resultNote', editor.readOnly);
      show('toolbar', true);
      show('mergeEditor', true);
      render();
      goToBlock();
    } else if (data.type === 'error') {
      setText('error', data.text);
      if (!file) setText('progress', 'Unable to open conflict');
      show('error', true);
    } else if (data.type === 'idle') {
      busy = false;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
