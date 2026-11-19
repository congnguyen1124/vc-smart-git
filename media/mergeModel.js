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

  function splitLines(text) {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  }

  // Keep exact matches as scroll anchors. Use unique lines to narrow large
  // diffs before trying a bounded longest common subsequence on smaller ranges.
  function alignLines(before, after) {
    const spans = [];
    let budget = 250_000;

    function append(beforeStart, beforeEnd, afterStart, afterEnd, equal = false) {
      if (beforeStart === beforeEnd && afterStart === afterEnd) return;
      const previous = spans.at(-1);
      if (previous?.equal === equal) {
        previous.beforeEnd = beforeEnd;
        previous.afterEnd = afterEnd;
      } else {
        spans.push({ beforeStart, beforeEnd, afterStart, afterEnd, equal });
      }
    }

    function uniqueLines(lines, start, end) {
      const positions = new Map();
      for (let index = start; index < end; index += 1) {
        const line = lines[index];
        positions.set(line, positions.has(line) ? -1 : index);
      }
      return positions;
    }

    function uniqueMatches(beforeStart, beforeEnd, afterStart, afterEnd) {
      const left = uniqueLines(before, beforeStart, beforeEnd);
      const right = uniqueLines(after, afterStart, afterEnd);
      const tails = [];
      for (const [line, index] of left) {
        const target = right.get(line);
        if (index < 0 || target === undefined || target < 0) continue;
        let low = 0;
        let high = tails.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (tails[mid].target < target) low = mid + 1;
          else high = mid;
        }
        tails[low] = { index, target, previous: tails[low - 1] };
      }
      const matches = [];
      for (let node = tails.at(-1); node; node = node.previous) matches.push(node);
      return matches.reverse();
    }

    function compare(beforeStart, beforeEnd, afterStart, afterEnd, useUniqueMatches) {
      let left = beforeStart;
      let right = afterStart;
      while (left < beforeEnd && right < afterEnd && before[left] === after[right]) {
        left += 1;
        right += 1;
      }
      append(beforeStart, left, afterStart, right, true);

      let leftEnd = beforeEnd;
      let rightEnd = afterEnd;
      while (left < leftEnd && right < rightEnd && before[leftEnd - 1] === after[rightEnd - 1]) {
        leftEnd -= 1;
        rightEnd -= 1;
      }

      const height = leftEnd - left;
      const width = rightEnd - right;
      if (height && width && (height + 1) * (width + 1) <= budget) {
        const stride = width + 1;
        const lengths = new Uint32Array((height + 1) * stride);
        budget -= lengths.length;
        for (let row = height - 1; row >= 0; row -= 1) {
          for (let col = width - 1; col >= 0; col -= 1) {
            const cell = row * stride + col;
            lengths[cell] = before[left + row] === after[right + col]
              ? lengths[cell + stride + 1] + 1
              : Math.max(lengths[cell + stride], lengths[cell + 1]);
          }
        }
        let row = 0;
        let col = 0;
        const startLeft = left;
        const startRight = right;
        while (row < height && col < width) {
          const cell = row * stride + col;
          if (before[startLeft + row] === after[startRight + col]) {
            const index = startLeft + row;
            const target = startRight + col;
            append(left, index, right, target);
            append(index, index + 1, target, target + 1, true);
            left = index + 1;
            right = target + 1;
            row += 1;
            col += 1;
          } else if (lengths[cell + stride] >= lengths[cell + 1]) row += 1;
          else col += 1;
        }
      } else if (height && width && useUniqueMatches) {
        for (const { index, target } of uniqueMatches(left, leftEnd, right, rightEnd)) {
          compare(left, index, right, target, false);
          append(index, index + 1, target, target + 1, true);
          left = index + 1;
          right = target + 1;
        }
      }
      append(left, leftEnd, right, rightEnd);
      append(leftEnd, beforeEnd, rightEnd, afterEnd, true);
    }

    compare(0, before.length, 0, after.length, true);
    return spans;
  }

  function conflictKey({ ours, theirs }) {
    return JSON.stringify([ours, theirs]);
  }

  function recoverConflictBases(working, reproduced, markerSize) {
    const current = scanConflicts(working, markerSize);
    const annotated = scanConflicts(reproduced, markerSize);
    if (current.malformed || annotated.malformed || current.blocks.length !== annotated.blocks.length) return [];
    const recovered = new Map();
    let currentEnd = 0;
    let annotatedEnd = 0;
    for (let index = 0; index < current.blocks.length; index += 1) {
      const block = current.blocks[index];
      const other = annotated.blocks[index];
      if (block.ours !== other.ours || block.theirs !== other.theirs || other.base === undefined ||
        working.slice(currentEnd, block.start) !== reproduced.slice(annotatedEnd, other.start)) return [];
      const key = conflictKey(block);
      if (!recovered.has(key)) recovered.set(key, other.base);
      else if (recovered.get(key) !== other.base) recovered.set(key, undefined);
      currentEnd = block.end;
      annotatedEnd = other.end;
    }
    if (working.slice(currentEnd) !== reproduced.slice(annotatedEnd)) return [];
    return [...recovered].filter(([, base]) => base !== undefined);
  }

  function tokenEdits(base, side) {
    const changes = (before, after, reverse) => alignLines(before, after)
      .filter((span) => !span.equal)
      .map(({ beforeStart, beforeEnd, afterStart, afterEnd }) => ({
        start: reverse ? base.length - beforeEnd : beforeStart,
        end: reverse ? base.length - beforeStart : beforeEnd,
        text: (reverse ? after.slice(afterStart, afterEnd).reverse() : after.slice(afterStart, afterEnd)).join(''),
      }));
    const forward = changes(base, side, false);
    const backward = changes([...base].reverse(), [...side].reverse(), true).reverse();
    // Repeated words can make it ambiguous which occurrence was changed.
    if (JSON.stringify(forward) === JSON.stringify(backward)) return forward;
    return undefined;
  }

  function resolveSimpleBlock({ ours, theirs, base }) {
    if (ours === theirs || theirs === base) return ours;
    if (ours === base) return theirs;
    if (base === undefined || ours.length + theirs.length + base.length > 12_000) return undefined;
    // Keep identifiers, numbers, and connected operators whole. An edit to
    // another letter in an already changed identifier still overlaps.
    const tokenize = (text) => text.match(/[\p{ID_Continue}$]+|[^\p{ID_Continue}$\s]+|[^\S\n]+|\n/gu) ?? [];
    const original = tokenize(base);
    const left = tokenEdits(original, tokenize(ours));
    const right = tokenEdits(original, tokenize(theirs));
    if (!left || !right) return undefined;
    const edits = [...left, ...right].sort((a, b) => a.start - b.start || a.end - b.end);
    const parts = [];
    let cursor = 0;
    let previous;
    for (const edit of edits) {
      if (previous && edit.start === previous.start && edit.end === previous.end && edit.text === previous.text) continue;
      if (edit.start < cursor || (previous && edit.start === cursor &&
        (edit.start === edit.end || previous.start === previous.end))) return undefined;
      parts.push(original.slice(cursor, edit.start).join(''), edit.text);
      cursor = edit.end;
      previous = edit;
    }
    parts.push(original.slice(cursor).join(''));
    return parts.join('');
  }

  function changeColors(base, lines) {
    const kinds = [];
    const removed = new Map();
    if (!base) return { kinds, removed };
    for (const span of alignLines(base, lines)) {
      if (span.equal) continue;
      const oldLength = span.beforeEnd - span.beforeStart;
      const newLength = span.afterEnd - span.afterStart;
      if (newLength === 0) removed.set(span.afterStart, oldLength);
      for (let line = span.afterStart; line < span.afterEnd; line += 1) {
        kinds[line] = oldLength ? 'modified' : 'added';
      }
    }
    return { kinds, removed };
  }

  function upperBound(spans, row, key) {
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle][key] <= row) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  // Result contains both alternatives and Git's marker lines. Lay out each
  // conflict as one region so Current and Incoming start at the same row.
  function groupConflictSpans(spans, blocks) {
    const grouped = [];
    let index = 0;
    let beforeStart = 0;
    let afterStart = 0;
    const append = (span) => grouped.push(span);

    function consume(until, emit) {
      while (index < spans.length && beforeStart < until) {
        const span = spans[index];
        const beforeEnd = Math.min(until, span.beforeEnd);
        const afterEnd = beforeEnd === span.beforeEnd ? span.afterEnd
          : span.afterStart + Math.round((beforeEnd - span.beforeStart) *
            (span.afterEnd - span.afterStart) / (span.beforeEnd - span.beforeStart));
        emit?.({ beforeStart, beforeEnd, afterStart, afterEnd, equal: span.equal });
        beforeStart = beforeEnd;
        afterStart = afterEnd;
        if (beforeEnd === span.beforeEnd) index += 1;
      }
    }

    for (const block of blocks) {
      consume(block.startLine, append);
      const start = afterStart;
      consume(block.endLine + 1);
      append({ beforeStart: block.startLine, beforeEnd: block.endLine + 1, afterStart: start, afterEnd: afterStart, equal: false });
    }
    consume(Infinity, append);
    return grouped;
  }

  function createPaneLayout(result, source, pad, blocks = []) {
    let height = 0;
    const alignment = alignLines(result, source);
    const visible = pad && blocks.length ? groupConflictSpans(alignment, blocks) : alignment;
    const spans = visible.map((span) => {
      const start = height;
      const sourceLength = span.afterEnd - span.afterStart;
      height += pad ? Math.max(sourceLength, span.beforeEnd - span.beforeStart) : sourceLength;
      return { ...span, start, end: height };
    });
    return { spans, height };
  }

  function mapRow(layout, row, toResult) {
    const inputStart = toResult ? 'start' : 'beforeStart';
    const inputEnd = toResult ? 'end' : 'beforeEnd';
    const outputStart = toResult ? 'beforeStart' : 'start';
    const outputEnd = toResult ? 'beforeEnd' : 'end';
    const span = layout.spans[upperBound(layout.spans, row, inputEnd)];
    if (!span) return layout.spans.at(-1)?.[outputEnd] ?? 0;
    return span[outputStart] + Math.max(0, row - span[inputStart]) *
      (span[outputEnd] - span[outputStart]) / (span[inputEnd] - span[inputStart]);
  }

  function paneRow(layout, row) {
    const span = layout.spans[upperBound(layout.spans, row, 'end')];
    if (!span) return undefined;
    const source = span.afterStart + row - span.start;
    return { source: Math.min(source, span.afterEnd), gap: source >= span.afterEnd };
  }

  return {
    scanConflicts, chooseBlock, ignoreBlockSide, conflictKey, recoverConflictBases, resolveSimpleBlock,
    splitLines, changeColors, createPaneLayout, mapRow, paneRow,
  };
});
