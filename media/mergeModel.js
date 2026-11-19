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

  function createDraft(text, markerSize, bases, noAncestor) {
    const scan = scanConflicts(text, markerSize);
    if (scan.malformed) return { text, blocks: [] };
    const parts = [];
    let previousEnd = 0;
    let offset = 0;
    const blocks = scan.blocks.map((original) => {
      const base = original.base ?? bases.get(conflictKey(original)) ?? (noAncestor ? '' : undefined);
      const context = text.slice(previousEnd, original.start);
      const start = offset + context.length;
      const end = start + (base?.length ?? 0);
      const simple = resolveSimpleBlock({ ...original, base });
      const candidate = simple === undefined ? undefined : scanConflicts(simple, markerSize);
      parts.push(context, base ?? '');
      previousEnd = original.end;
      offset = end;
      return {
        original, base, start, end, ours: null, theirs: null, manual: false,
        simple: candidate?.malformed || candidate?.blocks.length ? undefined : simple,
      };
    });
    parts.push(text.slice(previousEnd));
    return { text: parts.join(''), blocks };
  }

  function isPending(block) {
    return block.ours === null || block.theirs === null;
  }

  function canIgnoreSide(block, side) {
    const other = side === 'ours' ? block.theirs : block.ours;
    return block[side] === null && (other !== 'ignored' || block.base !== undefined || block.manual);
  }

  function canResolveSimple(block) {
    return block.simple !== undefined && !block.manual && block.ours === null && block.theirs === null;
  }

  function resolveSimpleDraft(draft) {
    const parts = [];
    let cursor = 0;
    let shift = 0;
    let count = 0;
    const blocks = draft.blocks.map((block) => {
      const start = block.start + shift;
      if (!canResolveSimple(block)) return shift ? { ...block, start, end: block.end + shift } : block;
      parts.push(draft.text.slice(cursor, block.start), block.simple);
      cursor = block.end;
      const end = start + block.simple.length;
      shift += block.simple.length - (block.end - block.start);
      count += 1;
      return { ...block, start, end, ours: 'processed', theirs: 'processed' };
    });
    parts.push(draft.text.slice(cursor));
    return { draft: count ? { text: parts.join(''), blocks } : draft, count };
  }

  function resolveBlock(draft, index, choice, side) {
    const block = draft.blocks[index];
    if (!block || !isPending(block)) return draft;
    let replacement = draft.text.slice(block.start, block.end);
    let next = { ...block };
    if (choice === 'take' && block[side] === null) {
      const content = block.original[side];
      const other = side === 'ours' ? block.theirs : block.ours;
      const append = block.manual || other === 'accepted';
      if (!append) replacement = content;
      else if (content && (other !== 'accepted' || replacement !== content)) {
        replacement += replacement && !replacement.endsWith('\n') ? '\n' + content : content;
      }
      next[side] = 'accepted';
    } else if (choice === 'ignore' && canIgnoreSide(block, side)) {
      next[side] = 'ignored';
    } else if (choice === 'keep') {
      next = { ...block, ours: block.ours ?? 'processed', theirs: block.theirs ?? 'processed' };
    } else if (choice === 'base' && block.base !== undefined) {
      replacement = block.base;
      next = { ...block, ours: 'ignored', theirs: 'ignored' };
    } else {
      return draft;
    }
    const end = block.start + replacement.length;
    const shift = end - block.end;
    return {
      text: draft.text.slice(0, block.start) + replacement + draft.text.slice(block.end),
      blocks: draft.blocks.map((entry, offset) => {
        if (offset < index) return entry;
        if (offset === index) return { ...next, end };
        return shift ? { ...entry, start: entry.start + shift, end: entry.end + shift } : entry;
      }),
    };
  }

  function editDraft(draft, text, selection, caret) {
    const previous = draft.text;
    if (previous === text) return draft;
    const shift = text.length - previous.length;
    let start = Math.min(selection?.start ?? 0, caret);
    let end = Math.max(selection?.end ?? 0, caret - shift);
    let newEnd = end + shift;
    // beforeinput covers normal typing and selection replacement. The text
    // comparison handles drag/drop, composition and other multi-line edits.
    if (!selection || end > previous.length || newEnd < start ||
      previous.slice(0, start) !== text.slice(0, start) || previous.slice(end) !== text.slice(newEnd)) {
      start = 0;
      end = previous.length;
      newEnd = text.length;
      while (start < end && start < newEnd && previous[start] === text[start]) start += 1;
      while (end > start && newEnd > start && previous[end - 1] === text[newEnd - 1]) {
        end -= 1;
        newEnd -= 1;
      }
    }
    let assigned = false;
    const blocks = draft.blocks.map((block) => {
      const atEmptyBlock = block.start === start && block.end === start;
      if (atEmptyBlock && assigned) return { ...block, start: newEnd, end: newEnd };
      if (block.end <= start && (!atEmptyBlock || !isPending(block))) return block;
      if (block.start >= end && (block.start !== start || assigned)) {
        return { ...block, start: block.start + shift, end: block.end + shift };
      }
      const first = !assigned;
      assigned = true;
      return {
        ...block, manual: true,
        start: block.start < start ? block.start : first ? start : newEnd,
        end: block.end >= end ? block.end + shift : newEnd,
      };
    });
    return { text, blocks };
  }

  function draftRegions({ text, blocks }) {
    const offsets = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\n') offsets.push(index + 1);
    }
    let previousEnd = 0;
    function rowAt(offset) {
      let low = 0;
      let high = offsets.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (offsets[middle] <= offset) low = middle + 1;
        else high = middle;
      }
      return low - 1;
    }
    return blocks.map(({ start, end }) => {
      const startLine = Math.max(previousEnd, rowAt(start));
      const last = rowAt(end);
      const endLine = Math.max(startLine, start === end || offsets[last] === end ? last : last + 1);
      previousEnd = endLine;
      return { startLine, endLine };
    });
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

  // The on-disk marker blocks identify each revision's original range.
  // Keep these anchors when decisions change the length of Result.
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

    for (const [conflict, block] of blocks.entries()) {
      consume(block.startLine, append);
      const start = afterStart;
      consume(block.endLine + 1);
      append({ beforeStart: block.startLine, beforeEnd: block.endLine + 1, afterStart: start, afterEnd: afterStart, equal: false, conflict });
    }
    consume(Infinity, append);
    return grouped;
  }

  function sourceRanges(working, source, blocks) {
    return groupConflictSpans(alignLines(working, source), blocks)
      .filter((span) => span.conflict !== undefined)
      .map(({ afterStart, afterEnd }) => ({ start: afterStart, end: afterEnd }));
  }

  function alignDraft(result, source, regions, ranges) {
    const spans = [];
    let beforeStart = 0;
    let afterStart = 0;
    function appendContext(beforeEnd, afterEnd) {
      for (const span of alignLines(result.slice(beforeStart, beforeEnd), source.slice(afterStart, afterEnd))) {
        spans.push({
          beforeStart: span.beforeStart + beforeStart, beforeEnd: span.beforeEnd + beforeStart,
          afterStart: span.afterStart + afterStart, afterEnd: span.afterEnd + afterStart, equal: span.equal,
        });
      }
    }
    regions.forEach(({ startLine, endLine }, conflict) => {
      const range = ranges[conflict];
      appendContext(startLine, range.start);
      spans.push({
        beforeStart: startLine, beforeEnd: endLine, afterStart: range.start, afterEnd: range.end,
        equal: false, conflict, minimum: range.minimum ?? 1,
      });
      beforeStart = endLine;
      afterStart = range.end;
    });
    appendContext(result.length, source.length);
    return spans;
  }

  function createPaneLayout(result, source, pad, regions = [], ranges = []) {
    let height = 0;
    const conflicts = [];
    const emptyAnchors = new Map();
    const visible = pad && regions.length ? alignDraft(result, source, regions, ranges) : alignLines(result, source);
    const spans = visible.map((span) => {
      const start = height;
      const sourceLength = span.afterEnd - span.afterStart;
      height += pad ? Math.max(sourceLength, span.beforeEnd - span.beforeStart, span.minimum ?? 0) : sourceLength;
      const positioned = { ...span, start, end: height };
      if (span.conflict !== undefined) {
        conflicts[span.conflict] = positioned;
        if (span.beforeStart === span.beforeEnd && !emptyAnchors.has(span.beforeStart)) emptyAnchors.set(span.beforeStart, start);
      }
      return positioned;
    });
    return { spans, height, conflicts, emptyAnchors };
  }

  function mapRow(layout, row, toResult) {
    if (!toResult && layout.emptyAnchors.has(row)) return layout.emptyAnchors.get(row);
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
    const position = { source: Math.min(source, span.afterEnd), gap: source >= span.afterEnd };
    if (span.conflict !== undefined) {
      position.conflict = span.conflict;
      position.first = row === span.start;
    }
    return position;
  }

  return {
    scanConflicts, conflictKey, recoverConflictBases, resolveSimpleBlock, createDraft, isPending,
    canIgnoreSide, canResolveSimple, resolveSimpleDraft, resolveBlock, editDraft, draftRegions,
    splitLines, changeColors, sourceRanges, createPaneLayout, mapRow, paneRow,
  };
});
