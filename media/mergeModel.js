(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartGitMerge = api;
})(globalThis, function () {
  'use strict';

  function scanConflicts(text, markerSize = 7) {
    const blocks = [];
    const lines = text.split('\n');
    const marker = new RegExp(`^([<|=>])\\1{${markerSize - 1}}(?:[ \t].*)?$`);
    let offset = 0;
    let block;
    let malformed = false;
    for (let line = 0; line < lines.length; line += 1) {
      const value = lines[line];
      const next = Math.min(text.length, offset + value.length + 1);
      const token = marker.exec(value)?.[1];
      if (token === '<' && !block) {
        block = { start: offset, startLine: line, oursStart: next };
      } else if (token === '|' && block && block.baseStart === undefined && block.theirsStart === undefined) {
        block.ours = text.slice(block.oursStart, offset);
        block.baseStart = next;
      } else if (token === '=' && block && block.theirsStart === undefined) {
        if (block.baseStart === undefined) block.ours = text.slice(block.oursStart, offset);
        else block.base = text.slice(block.baseStart, offset);
        block.theirsStart = next;
      } else if (token === '>' && block?.theirsStart !== undefined) {
        blocks.push({
          start: block.start, end: next, startLine: block.startLine, endLine: line,
          ours: block.ours, theirs: text.slice(block.theirsStart, offset), base: block.base,
        });
        block = undefined;
      } else if (token && (token !== '=' || block)) {
        malformed = true;
      }
      offset = next;
    }
    return { blocks, malformed: malformed || Boolean(block), lineCount: lines.length };
  }

  function chooseBlock(block, choice) {
    if (choice === 'both') return block.ours + block.theirs;
    if (choice === 'theirs') return block.theirs;
    return block.ours;
  }

  function ignoreBlockSide(block, ignored, side) {
    if (ignored === side) return { ignored: undefined };
    if (!ignored) return { ignored: side };
    if (block.base !== undefined) return { replacement: block.base };
    return undefined;
  }

  return { scanConflicts, chooseBlock, ignoreBlockSide };
});
