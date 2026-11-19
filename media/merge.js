(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const {
    scanConflicts, chooseBlock, ignoreBlockSide, conflictKey, resolveSimpleBlock,
    splitLines, changeColors, createPaneLayout, mapRow, paneRow,
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
  let scan = { blocks: [], malformed: false };
  let activeIndex = 0;
  let showRevision = false;
  let showBase = false;
  let busy = false;
  let ignoredSides = [];
  let conflictBases;
  let simpleResolutions = [];
  let resolvedNotice = '';
  let revisions;
  let comparedText;
  let resultLines;
  let resultColors;
  let rowHeight = 21;
  const undo = [];
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
    return Object.fromEntries(['ours', 'theirs', 'base'].map((key) => {
      const version = file[key];
      const lines = splitLines(version.text);
      const columns = lines.reduce((width, line) => Math.max(width, line.replaceAll('\t', '    ').length), 0);
      const colors = version.text !== undefined || !version.present ? changeColors(base, lines) : changeColors();
      return [key, { ...version, lines, columns, colors }];
    }));
  }

  function updateLayouts() {
    const edited = comparedText !== editor.value;
    if (edited) {
      comparedText = editor.value;
      resultLines = editor.value.split('\n');
      const base = revisions.base.text !== undefined || !revisions.base.present ? revisions.base.lines : undefined;
      resultColors = changeColors(base, splitLines(editor.value));
    }
    rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
    for (const pane of sides) {
      const revision = revisions[pane.side === 'ours' && showBase ? 'base' : pane.side];
      const pad = !showRevision && file.working.text !== undefined && (revision.text !== undefined || !revision.present);
      if (edited || pane.revision !== revision || pane.pad !== pad) {
        pane.revision = revision;
        pane.pad = pad;
        pane.layout = createPaneLayout(resultLines, revision.lines, pad, scan.blocks);
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
    let high = scan.blocks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (scan.blocks[mid].endLine < row) low = mid + 1;
      else high = mid;
    }
    return scan.blocks[low]?.startLine <= row ? low : -1;
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
    const block = scan.blocks[activeIndex];
    const ignored = ignoredSides[activeIndex];
    const actionRow = block && hasRail
      ? Math.min(layout.height - 1, Math.floor(mapRow(layout, block.startLine, false))) : -1;
    const fragment = document.createDocumentFragment();
    for (let row = first; row < last; row += 1) {
      const position = paneRow(layout, row);
      const source = position?.source ?? revision.lines.length;
      const resultLine = Math.floor(mapRow(layout, row, true));
      const blockIndex = blockAt(resultLine);
      const isIgnored = hasRail && blockIndex >= 0 && ignoredSides[blockIndex] === side;
      const gap = position?.gap;
      const removed = revision.colors.removed.has(source) && paneRow(layout, row - 1)?.source !== source;
      if (!position && !removed) continue;
      const line = element('div', `code-line${gap ? ' diff-gap' : ''}${isIgnored ? ' ignored' : ''}`);
      applyChangeStyle(line, isIgnored || (gap && revision.colors.removed.has(source))
        ? 'removed' : !gap && revision.colors.kinds[source]);
      if (removed) {
        const count = revision.colors.removed.get(source);
        line.classList.add('deletion-boundary');
        line.title = `${count} ${count === 1 ? 'line' : 'lines'} removed`;
      }
      if (isIgnored) line.title = 'Ignored for this conflict';
      line.append(element('span', 'line-number', position && !gap ? String(source + 1) : ''));
      const contents = element('span', 'code-text');
      if (position && !gap) appendCode(contents, revision.lines[source]);
      line.append(contents);
      if (hasRail) {
        const rail = element('span', 'merge-rail');
        if (row === actionRow) appendBlockActions(rail, {
          side, ignored: ignored === side,
          canIgnore: Boolean(ignoreBlockSide(block, ignored, side)),
          usesBase: Boolean(ignored && ignored !== side && block.base !== undefined),
          busy,
        });
        line.append(rail);
      }
      fragment.append(line);
    }
    rows.style.top = `${first * rowHeight}px`;
    const focused = rows.contains(document.activeElement) ? document.activeElement.dataset.mergeAction : undefined;
    rows.replaceChildren(fragment);
    if (focused) {
      const control = rows.querySelector(`[data-merge-action="${focused}"]:enabled`);
      (control || scroll).focus({ preventScroll: true });
    }
  }

  function appendBlockActions(rail, { side, ignored, canIgnore, usesBase, busy }) {
    const left = side === 'ours';
    const label = left ? 'Current' : 'Incoming';
    const button = (action, icon, title, disabled) => {
      const control = element('button', `merge-inline merge-inline-${action}`, icon);
      control.type = 'button';
      control.dataset.mergeAction = action;
      control.dataset.mergeSide = side;
      control.setAttribute('aria-label', title);
      control.title = title;
      control.disabled = disabled;
      return control;
    };
    const apply = button('take', left ? '»' : '«', `Use ${label} for this conflict`, ignored || busy);
    const ignoreLabel = ignored ? `Restore ${label} for this conflict`
      : `Ignore ${label} for this conflict${usesBase ? ' and use Base' : ''}`;
    const ignore = button('ignore', ignored ? '↶' : '×', ignoreLabel, !canIgnore || busy);
    if (!canIgnore) ignore.title = 'Choose the remaining side or edit Result when Base is unavailable';
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
      const block = blockAt(line);
      const number = element('div', block === activeIndex ? 'active-marker' : block >= 0 ? 'marker' : '', String(line + 1));
      const background = element('div', '');
      const kind = block < 0 ? resultColors.kinds[line] : undefined;
      applyChangeStyle(number, kind);
      applyChangeStyle(background, kind);
      if (block >= 0) background.classList.add('diff-conflict');
      if (block < 0 && resultColors.removed.has(line)) {
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
      const resultRow = pane ? mapRow(pane.layout, row, true) : row;
      for (const target of [editor, ...sides.map(({ scroll }) => scroll)]) {
        if (target === source) continue;
        const other = paneFor.get(target);
        const targetRow = other ? mapRow(other.layout, resultRow, false) : resultRow;
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
    const block = scan.blocks[activeIndex];
    if (!block) return;
    editor.scrollTop = Math.max(0, (block.startLine - 5) * rowHeight);
    scrollPositions.set(editor, editor.scrollTop);
    syncScroll();
  }

  function render() {
    if (!file) return;
    if (comparedText !== editor.value) {
      scan = scanConflicts(editor.value, file.markerSize);
      simpleResolutions = scan.malformed ? [] : scan.blocks.map((block) => {
        const replacement = resolveSimpleBlock({ ...block, base: block.base ?? conflictBases.get(conflictKey(block)) });
        if (replacement === undefined) return undefined;
        const remaining = scanConflicts(replacement, file.markerSize);
        return remaining.malformed || remaining.blocks.length ? undefined : replacement;
      });
    }
    const count = scan.blocks.length;
    activeIndex = Math.max(0, Math.min(activeIndex, count - 1));
    const block = scan.blocks[activeIndex];
    const ignored = ignoredSides[activeIndex];
    const simpleCount = simpleResolutions.filter((replacement, index) => replacement !== undefined && !ignoredSides[index]).length;
    const editable = file.working.text !== undefined;
    editor.readOnly = busy || !editable;
    const ready = editable && !count && !scan.malformed;
    const title = !editable ? 'Choose a revision' : scan.malformed ? 'Check conflict markers'
      : count ? `${count} unresolved` : 'Ready to stage';
    setText('progress', title);
    byId('progress').className = `status ${ready ? 'resolved' : 'unresolved'}`;
    setText('position', count ? `Conflict ${activeIndex + 1} of ${count}` : 'No conflict blocks');
    const oursLabel = file.oursLabel && file.oursLabel !== '(detached)' ? file.oursLabel : 'Git index · Stage 2';
    const theirsLabel = file.theirsLabel || 'Git index · Stage 3';
    setText('oursName', showBase ? 'Base' : file.operation === 'rebase' ? 'Rebase target' : 'Current');
    setText('oursMeta', showBase ? 'Common ancestor' : oursLabel);
    setText('theirsMeta', theirsLabel);
    setText('resultMeta', editable && editor.value !== file.working.text ? 'Edited in this tab' : 'Editable working copy');
    setText('footerHelp', file.working.note || resolvedNotice || (scan.malformed ? 'Remove or repair the incomplete conflict markers in Result.'
      : ignored ? `${ignored === 'ours' ? 'Current' : 'Incoming'} ignored for this block. Choose a resolution or edit Result.`
        : count ? 'Use the arrows to take a side, or × to ignore it for this block.'
        : 'Apply & Stage saves the result and marks this file as resolved.'));
    const disabled = {
      previous: count < 2, next: count < 2, toggleRevision: !editable, toggleBase: !file.base.present,
      resolveSimple: !editable || !simpleCount,
      useOurs: !block || ignored === 'ours', useTheirs: !block || ignored === 'theirs',
      useBoth: !block || Boolean(ignored), useBase: block?.base === undefined,
      undoChoice: undo.at(-1)?.after !== editor.value, apply: !ready,
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
    show('useBase', block?.base !== undefined);
    updateLayouts();
    syncScroll(editor, true);
  }

  function choose(choice) {
    const block = scan.blocks[activeIndex];
    if (!block || busy) return;
    const replacement = choice === 'base' ? block.base : chooseBlock(block, choice);
    if (replacement === undefined) return;
    replaceBlock(block, replacement);
  }

  function changeBlock(update) {
    const before = editor.value;
    const ignored = [...ignoredSides];
    const index = activeIndex;
    resolvedNotice = '';
    update();
    undo.push({ before, after: editor.value, index, ignored });
    if (undo.length > 10) undo.shift();
    render();
  }

  function replaceBlock(block, replacement) {
    changeBlock(() => {
      editor.setRangeText(replacement, block.start, block.end, 'preserve');
      ignoredSides.splice(activeIndex, 1);
    });
    goToBlock();
  }

  function resolveSimple() {
    if (byId('resolveSimple').disabled) return;
    changeBlock(() => {
      const workingText = editor.value;
      const parts = [];
      const remainingIgnored = [];
      let start = 0;
      let resolved = 0;
      let first = activeIndex;
      for (const [index, block] of scan.blocks.entries()) {
        const replacement = simpleResolutions[index];
        if (replacement === undefined || ignoredSides[index]) {
          remainingIgnored.push(ignoredSides[index]);
          continue;
        }
        parts.push(workingText.slice(start, block.start), replacement);
        start = block.end;
        resolved += 1;
        if (index < activeIndex) first -= 1;
      }
      parts.push(workingText.slice(start));
      editor.setRangeText(parts.join(''), 0, workingText.length, 'preserve');
      activeIndex = first;
      ignoredSides = remainingIgnored;
      resolvedNotice = `Resolved ${resolved} simple conflict${resolved === 1 ? '' : 's'} in Result.`;
    });
    goToBlock();
    const next = !byId('apply').disabled ? byId('apply') : byId('undoChoice');
    next.focus({ preventScroll: true });
  }

  function inlineAction(event) {
    const button = event.target.closest('[data-merge-action]');
    if (!button || busy) return;
    const block = scan.blocks[activeIndex];
    const side = button.dataset.mergeSide;
    if (!block) return;
    if (button.dataset.mergeAction === 'take') {
      choose(side);
    } else {
      const decision = ignoreBlockSide(block, ignoredSides[activeIndex], side);
      if (!decision) return;
      if (decision.replacement !== undefined) replaceBlock(block, decision.replacement);
      else changeBlock(() => { ignoredSides[activeIndex] = decision.ignored; });
    }
    const next = document.querySelector(`[data-merge-action="${button.dataset.mergeAction}"][data-merge-side="${side}"]:enabled`);
    (next || (!byId('apply').disabled ? byId('apply') : byId('undoChoice'))).focus({ preventScroll: true });
  }

  function move(offset) {
    if (scan.blocks.length < 2) return;
    activeIndex = (activeIndex + offset + scan.blocks.length) % scan.blocks.length;
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
  byId('useOurs').onclick = () => choose('ours');
  byId('useTheirs').onclick = () => choose('theirs');
  byId('useBoth').onclick = () => choose('both');
  byId('useBase').onclick = () => choose('base');
  byId('acceptOurs').onclick = () => submit('acceptSide', { side: 'ours' });
  byId('acceptTheirs').onclick = () => submit('acceptSide', { side: 'theirs' });
  byId('close').onclick = () => submit('close', { dirty: Boolean(file && !editor.readOnly && editor.value !== file.working.text) });
  byId('apply').onclick = () => submit('apply', { text: editor.value });
  byId('undoChoice').onclick = () => {
    const choice = undo.at(-1);
    if (choice?.after !== editor.value) return;
    undo.pop();
    editor.value = choice.before;
    resolvedNotice = '';
    ignoredSides = choice.ignored;
    activeIndex = choice.index;
    render();
    goToBlock();
  };
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
  editor.addEventListener('input', () => {
    ignoredSides = [];
    resolvedNotice = '';
    undo.length = 0;
    render();
  });
  editor.addEventListener('scroll', onScroll, { passive: true });
  resize.observe(editor);
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'file') {
      file = data;
      revisions = loadRevisions();
      conflictBases = new Map(file.conflictBases ?? []);
      comparedText = undefined;
      setText('fileName', file.path.split('/').pop());
      setText('fileLocation', `${file.repository} / ${file.path}`);
      byId('fileLocation').title = byId('fileLocation').textContent;
      editor.value = file.working.text ?? '';
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
