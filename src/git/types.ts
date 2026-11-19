export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'untracked'
  | 'conflicted';

export interface GitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: ChangeKind;
  hasStagedChange: boolean;
  hasWorkingTreeChange: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branch: string;
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export type GitConflictSideStatus = 'Modified' | 'Added' | 'Deleted';

export interface GitConflict {
  path: string;
  status: string;
  ours: GitConflictSideStatus;
  theirs: GitConflictSideStatus;
  oursAvailable: boolean;
  theirsAvailable: boolean;
  simple: boolean;
  simpleReason?: 'identical' | 'bothDeleted';
}

export interface GitConflictState {
  currentBranch: string;
  incomingLabel?: string;
  operation?: GitOperation;
  files: GitConflict[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  refs: string[];
  subject: string;
  body: string;
}

export interface GitCommitFile {
  status: string;
  path: string;
  originalPath?: string;
}

export interface GitBranch {
  ref: string;
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  tracking?: string;
  ahead: number;
  behind: number;
  worktreePath?: string;
  hash: string;
  committedAt?: string;
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface RepositorySummary {
  root: string;
  name: string;
}
