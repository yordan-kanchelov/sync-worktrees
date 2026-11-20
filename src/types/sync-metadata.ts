export interface SyncMetadata {
  lastSyncCommit: string;
  lastSyncDate: string;
  upstreamBranch: string;
  lastKnownRemoteTip?: LastKnownRemoteTip;
}

export interface LastKnownRemoteTip {
  ref: string;
  oid: string;
  recordedAt: string;
}
