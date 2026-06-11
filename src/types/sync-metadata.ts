export interface SyncMetadata {
  lastSyncCommit: string;
  lastSyncDate: string;
  upstreamBranch: string;
  createdFrom: {
    branch: string;
    commit: string;
  };
  syncHistory: SyncHistoryEntry[];
  // Last commit observed on the upstream ref while it still existed. Git
  // discards this fact when the remote branch is deleted (e.g. after a
  // squash-merge), so it is recorded here and deliberately never cleared —
  // it is the only proof that HEAD was fully pushed before the deletion.
  lastKnownRemoteTip?: LastKnownRemoteTip;
}

export interface LastKnownRemoteTip {
  ref: string;
  oid: string;
  recordedAt: string;
}

export interface SyncHistoryEntry {
  date: string;
  commit: string;
  action: "created" | "updated" | "fetched";
}
