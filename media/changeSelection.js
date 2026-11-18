(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SmartGitChangeSelection = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function resolveChangeSelection(order, currentKeys, anchorKey, targetKey, modifiers = {}) {
    const orderedKeys = [...new Set(order)];
    if (!orderedKeys.includes(targetKey)) {
      return {
        keys: orderedKeys.filter((key) => currentKeys.includes(key)),
        anchorKey: orderedKeys.includes(anchorKey) ? anchorKey : undefined,
      };
    }

    if (modifiers.range) {
      const resolvedAnchor = orderedKeys.includes(anchorKey) ? anchorKey : targetKey;
      const anchorIndex = orderedKeys.indexOf(resolvedAnchor);
      const targetIndex = orderedKeys.indexOf(targetKey);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const rangeKeys = orderedKeys.slice(start, end + 1);
      const keys = modifiers.additive
        ? orderedKeys.filter((key) => currentKeys.includes(key) || rangeKeys.includes(key))
        : rangeKeys;
      return { keys, anchorKey: resolvedAnchor };
    }

    if (modifiers.toggle) {
      const keys = new Set(currentKeys.filter((key) => orderedKeys.includes(key)));
      if (keys.has(targetKey) && keys.size > 1) {
        keys.delete(targetKey);
      } else {
        keys.add(targetKey);
      }
      return { keys: orderedKeys.filter((key) => keys.has(key)), anchorKey: targetKey };
    }

    return { keys: [targetKey], anchorKey: targetKey };
  }

  return { resolveChangeSelection };
});
