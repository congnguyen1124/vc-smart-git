(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { scanConflicts, chooseBlock, ignoreBlockSide } = globalThis.SmartGitMerge;
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
  let lineCount = 0;
  let ignoredSides = [];
  const undo = [];
  const codeCache = new Map();

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

  function renderCode(id, version, context) {
    const target = byId(id);
    const contextKey = context && JSON.stringify(context);
    const cached = codeCache.get(id);
    if (cached?.version === version && cached.contextKey === contextKey) return;
    codeCache.set(id, { version, contextKey });
    const scroll = context ? 0 : target.scrollTop;
    target.classList.toggle('has-merge-rail', Boolean(context?.actions));
    target.replaceChildren();
    if (!context && version.text === undefined) {
      target.append(element('p', 'empty muted', version.note || 'This version has no file at this path.'));
      return;
    }
    const source = context?.lines ?? version.text.split('\n');
    const fragment = document.createDocumentFragment();
    source.slice(0, 1500).forEach((text, index) => {
      const changed = context && index >= context.start && index < context.end;
      const line = element('div', `code-line${changed ? ' changed' : ''}`);
      if (changed && context.actions?.ignored) line.classList.add('ignored');
      line.append(element('span', 'line-number', String((context?.first ?? 1) + index)));
      const contents = element('span', 'code-text');
      appendCode(contents, text);
      line.append(contents);
      if (context?.actions) {
        const rail = element('span', 'merge-rail');
        if (index === context.start) appendBlockActions(rail, context.actions);
        line.append(rail);
      }
      fragment.append(line);
    });
    if (source.length > 1500) fragment.append(element('p', 'empty muted', 'Preview shows the first 1,500 lines.'));
    target.append(fragment);
    target.scrollTop = scroll;
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

  function blockContext(block, side) {
    if (!block || showRevision || (side === 'base' && block.base === undefined)) return undefined;
    const lines = editor.value.split('\n');
    const first = Math.max(0, block.startLine - 5);
    const prefix = lines.slice(first, block.startLine);
    const value = block[side];
    const changed = value ? value.replace(/\n$/, '').split('\n') : [''];
    const suffix = lines.slice(block.endLine + 1, block.endLine + 8);
    const ignored = ignoredSides[activeIndex];
    const actions = side === 'base' ? undefined : {
      side,
      ignored: ignored === side,
      canIgnore: Boolean(ignoreBlockSide(block, ignored, side)),
      usesBase: Boolean(ignored && ignored !== side && block.base !== undefined),
      busy,
    };
    return { lines: [...prefix, ...changed, ...suffix], first: first + 1, start: prefix.length, end: prefix.length + changed.length, actions };
  }

  function renderGutter() {
    if (file?.working.text === undefined) return;
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
    const first = Math.max(0, Math.floor(editor.scrollTop / lineHeight));
    const last = Math.min(lineCount, first + Math.ceil(editor.clientHeight / lineHeight) + 1);
    const gutter = byId('gutter');
    gutter.style.setProperty('--offset', `${first * lineHeight - editor.scrollTop}px`);
    const children = [];
    for (let line = first; line < last; line += 1) {
      const block = scan.blocks.findIndex((entry) => line >= entry.startLine && line <= entry.endLine);
      children.push(element('div', block === activeIndex ? 'active-marker' : block >= 0 ? 'marker' : '', String(line + 1)));
    }
    gutter.replaceChildren(...children);
  }

  function goToBlock() {
    const block = scan.blocks[activeIndex];
    if (!block) return;
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
    editor.scrollTop = Math.max(0, (block.startLine - 5) * lineHeight);
    renderGutter();
  }

  function render() {
    if (!file) return;
    scan = scanConflicts(editor.value, file.markerSize);
    lineCount = scan.lineCount;
    const count = scan.blocks.length;
    activeIndex = Math.max(0, Math.min(activeIndex, count - 1));
    const block = scan.blocks[activeIndex];
    const ignored = ignoredSides[activeIndex];
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
    setText('footerHelp', file.working.note || (scan.malformed ? 'Remove or repair the incomplete conflict markers in Result.'
      : ignored ? `${ignored === 'ours' ? 'Current' : 'Incoming'} ignored for this block. Choose a resolution or edit Result.`
        : count ? 'Use the arrows to take a side, or × to ignore it for this block.'
        : 'Apply & Stage saves the result and marks this file as resolved.'));
    const disabled = {
      previous: count < 2, next: count < 2, toggleRevision: !count, toggleBase: !file.base.present,
      useOurs: !block || ignored === 'ours', useTheirs: !block || ignored === 'theirs',
      useBoth: !block || Boolean(ignored), useBase: block?.base === undefined,
      undoChoice: undo.at(-1)?.after !== editor.value, apply: !ready,
      acceptOurs: false, acceptTheirs: false,
    };
    for (const [id, unavailable] of Object.entries(disabled)) byId(id).disabled = busy || unavailable;
    byId('close').disabled = busy;
    byId('toggleRevision').setAttribute('aria-pressed', String(showRevision));
    byId('toggleBase').setAttribute('aria-pressed', String(showBase));
    setText('toggleRevision', showRevision ? 'Conflict context' : 'Full revisions');
    setText('toggleBase', showBase ? 'Show current' : 'Show base');
    setText('acceptOurs', file.ours.present ? 'Entire Current…' : 'Accept Deletion…');
    setText('acceptTheirs', file.theirs.present ? 'Entire Incoming…' : 'Accept Deletion…');
    show('useBase', block?.base !== undefined);
    renderCode('oursCode', showBase ? file.base : file.ours, blockContext(block, showBase ? 'base' : 'ours'));
    renderCode('theirsCode', file.theirs, blockContext(block, 'theirs'));
    renderGutter();
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
    update();
    undo.push({ before, after: editor.value, index: activeIndex, ignored });
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
    ignoredSides = choice.ignored;
    activeIndex = choice.index;
    render();
    goToBlock();
  };
  byId('toggleRevision').onclick = () => { showRevision = !showRevision; render(); };
  byId('toggleBase').onclick = () => { showBase = !showBase; render(); };
  byId('oursCode').addEventListener('click', inlineAction);
  byId('theirsCode').addEventListener('click', inlineAction);
  editor.addEventListener('input', () => {
    ignoredSides = [];
    undo.length = 0;
    render();
  });
  editor.addEventListener('scroll', renderGutter, { passive: true });
  new ResizeObserver(renderGutter).observe(editor);
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'file') {
      file = data;
      setText('fileName', file.path.split('/').pop());
      setText('fileLocation', `${file.repository} / ${file.path}`);
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
