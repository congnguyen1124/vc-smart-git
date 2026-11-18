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

  return { layoutCommitGraph };
});
