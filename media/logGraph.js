(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SmartGitLogGraph = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function layoutCommitGraph(commits) {
    let lanes = [];
    let nextColor = 0;
    let maxLaneCount = 1;

    const rows = commits.map((commit) => {
      let currentLane = lanes.findIndex((lane) => lane.hash === commit.hash);
      if (currentLane < 0) {
        currentLane = lanes.length;
        lanes.push({ hash: commit.hash, color: nextColor++ });
      }

      const current = lanes[currentLane];
      const top = lanes.map((lane) => ({ ...lane }));
      const bottom = lanes.map((lane) => ({ ...lane }));
      const parents = [...new Set((commit.parents || []).filter(Boolean))];

      if (!parents.length) {
        bottom.splice(currentLane, 1);
      } else {
        const firstParent = parents[0];
        const existingFirst = bottom.findIndex((lane, index) => index !== currentLane && lane.hash === firstParent);
        if (existingFirst >= 0) {
          bottom.splice(currentLane, 1);
        } else {
          bottom[currentLane] = { hash: firstParent, color: current.color };
        }

        let insertionOffset = 1;
        parents.slice(1).forEach((parent) => {
          if (bottom.some((lane) => lane.hash === parent)) {
            return;
          }
          const insertionLane = Math.min(currentLane + insertionOffset, bottom.length);
          bottom.splice(insertionLane, 0, { hash: parent, color: nextColor++ });
          insertionOffset += 1;
        });
      }

      const continuations = top
        .map((lane, from) => ({ lane, from }))
        .filter(({ lane }) => lane.hash !== commit.hash)
        .map(({ lane, from }) => ({
          from,
          to: bottom.findIndex((candidate) => candidate.hash === lane.hash),
          color: lane.color,
        }))
        .filter((connection) => connection.to >= 0);
      const parentConnections = parents
        .map((parent) => {
          const to = bottom.findIndex((lane) => lane.hash === parent);
          return to < 0 ? undefined : { to, color: bottom[to].color };
        })
        .filter(Boolean);

      maxLaneCount = Math.max(maxLaneCount, top.length, bottom.length, currentLane + 1);
      lanes = bottom;
      return {
        currentLane,
        currentColor: current.color,
        continuations,
        parentConnections,
        merge: parents.length > 1,
      };
    });

    return { rows, maxLaneCount };
  }

  function commitRefPresentations(commit, branches, status) {
    const refs = [];
    const seen = new Set();
    const add = (label, type, icon, title) => {
      const key = `${type}:${label}`;
      if (!label || seen.has(key)) return;
      seen.add(key);
      refs.push({ label, type, icon, title: title || label });
    };
    const matchingBranches = (branches || [])
      .filter((branch) => branch.hash === commit.hash)
      .sort((left, right) => Number(right.current) - Number(left.current) || Number(left.remote) - Number(right.remote) || left.name.localeCompare(right.name));

    matchingBranches.forEach((branch) => {
      if (branch.current) {
        add(`HEAD \u2192 ${branch.name}`, 'head', '\u25c6', `${branch.name} is currently checked out`);
      } else if (branch.remote) {
        add(branch.name, 'remote', '\u25c7', `Remote branch ${branch.name}`);
      } else if (branch.worktreePath) {
        add(branch.name, 'worktree', '\u25c6', `${branch.name} is checked out in ${branch.worktreePath}`);
      } else {
        add(branch.name, 'branch', '\u25c7', `Local branch ${branch.name}`);
      }
    });

    if (status?.oid === commit.hash && !matchingBranches.some((branch) => branch.current)) {
      add('HEAD (detached)', 'head', '\u25c6', 'Detached HEAD is currently checked out here');
    }

    const branchNames = new Set((branches || []).map((branch) => branch.name));
    (commit.refs || []).forEach((raw) => {
      if (raw.startsWith('tag: ')) {
        add(raw.slice(5), 'tag', '\u25c7', `Tag ${raw.slice(5)}`);
        return;
      }
      if (raw.endsWith('/HEAD') || raw.includes('/HEAD -> ')) return;
      const target = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
      if (!target || target === 'HEAD' || branchNames.has(target)) return;
      add(target, 'branch', '\u25c7', target);
    });
    return refs;
  }

  function resizeLogPanes(containerWidth, currentLeft, currentRight, side, requestedWidth) {
    const minLeft = 150;
    const minCenter = 320;
    const minRight = 220;
    const gutters = 10;
    const available = Math.max(0, containerWidth - gutters);
    let left = Math.max(minLeft, Number(currentLeft) || minLeft);
    let right = Math.max(minRight, Number(currentRight) || minRight);
    if (available < minLeft + minCenter + minRight) return { left, right };
    if (side === 'left') {
      left = Math.min(Math.max(minLeft, requestedWidth), available - minCenter - right);
    } else if (side === 'right') {
      right = Math.min(Math.max(minRight, requestedWidth), available - minCenter - left);
    }
    return { left: Math.round(left), right: Math.round(right) };
  }

  return { layoutCommitGraph, commitRefPresentations, resizeLogPanes };
});
