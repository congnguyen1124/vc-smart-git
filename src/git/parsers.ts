import type { GitBranch, GitChange, GitCommit, GitStatus } from './types';

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function kindFor(indexStatus: string, worktreeStatus: string, conflicted: boolean): GitChange['kind'] {
  if (conflicted) {
    return 'conflicted';
  }

  const code = worktreeStatus !== '.' ? worktreeStatus : indexStatus;
  switch (code) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typeChanged';
    case '?': return 'untracked';
    default: return 'modified';
  }
}

function change(path: string, xy: string, originalPath?: string, forcedConflict = false): GitChange {
  const indexStatus = xy[0] ?? '.';
  const worktreeStatus = xy[1] ?? '.';
  const conflicted = forcedConflict || CONFLICT_CODES.has(xy);
  return {
    path,
    ...(originalPath ? { originalPath } : {}),
    indexStatus,
    worktreeStatus,
    kind: kindFor(indexStatus, worktreeStatus, conflicted),
    hasStagedChange: !conflicted && indexStatus !== '.' && indexStatus !== '?',
    hasWorkingTreeChange: conflicted || worktreeStatus !== '.' || indexStatus === '?',
    conflicted,
  };
}

export function parsePorcelainV2(output: string): GitStatus {
  const records = output.split('\0');
  const changes: GitChange[] = [];
  let branch = 'HEAD';
  let oid: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      branch = record.slice('# branch.head '.length);
      continue;
    }
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length);
      if (value !== '(initial)') {
        oid = value;
      }
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      if (fields.length >= 9) {
        changes.push(change(fields.slice(8).join(' '), fields[1] ?? '..'));
      }
      continue;
    }
    if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      const originalPath = records[index + 1];
      if (fields.length >= 10 && originalPath !== undefined) {
        changes.push(change(fields.slice(9).join(' '), fields[1] ?? '..', originalPath));
        index += 1;
      }
      continue;
    }
    if (record.startsWith('u ')) {
      const fields = record.split(' ');
      if (fields.length >= 11) {
        changes.push(change(fields.slice(10).join(' '), fields[1] ?? 'UU', undefined, true));
      }
      continue;
    }
    if (record.startsWith('? ')) {
      changes.push(change(record.slice(2), '??'));
    }
  }

  changes.sort((left, right) => {
    if (left.conflicted !== right.conflicted) {
      return left.conflicted ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });

  return { branch, ...(oid ? { oid } : {}), ...(upstream ? { upstream } : {}), ahead, behind, changes };
}

export function parseLog(output: string): GitCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      const refs = (fields[6] ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean);
      return {
        hash: fields[0] ?? '',
        shortHash: fields[1] ?? '',
        parents: (fields[2] ?? '').split(' ').filter(Boolean),
        authorName: fields[3] ?? '',
        authorEmail: fields[4] ?? '',
        authoredAt: fields[5] ?? '',
        refs,
        subject: fields[7] ?? '',
        body: fields.slice(8).join('\0').trim(),
      };
    })
    .filter((entry) => entry.hash.length > 0);
}

export function parseBranches(output: string): GitBranch[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\0');
      const ref = fields[0] ?? '';
      return {
        ref,
        name: fields[1] ?? ref,
        current: fields[2] === '*',
        remote: ref.startsWith('refs/remotes/'),
        ...(fields[3] ? { upstream: fields[3] } : {}),
        ...(fields[4] ? { tracking: fields[4] } : {}),
        hash: fields[5] ?? '',
        ...(fields[6] ? { committedAt: fields[6] } : {}),
      };
    });
}
