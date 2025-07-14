export interface SyncMetadata {
  lastSyncCommit: string;
  lastSyncDate: string;
  upstreamBranch: string;
  createdFrom: {
    branch: string;
    commit: string;
  };
  syncHistory: SyncHistoryEntry[];
}

export interface SyncHistoryEntry {
  date: string;
  commit: string;
  action: "created" | "updated" | "fetched";
}
