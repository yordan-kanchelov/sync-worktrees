import * as fs from "fs/promises";
import * as path from "path";

import type { WorktreeStatusResult } from "./worktree-status.service";

export type RemovalAuditAction =
  | "prune_remove"
  | "diverged_replace"
  | "diverged_discard"
  | "keep_ref_delete"
  | "trash_create"
  | "trash_adopt"
  | "trash_restore"
  | "trash_purge"
  | "trash_reap";

export interface RemovalAuditEntry {
  action: RemovalAuditAction;
  result: "attempt" | "success" | "failure";
  path: string;
  branch?: string;
  status?: WorktreeStatusResult;
  quarantinePath?: string;
  trashId?: string;
  trashPath?: string;
  error?: string;
}

// Append-only JSONL log of destructive worktree operations (not the stale-dir
// rmdir/quarantine at worktree creation). It outlives the terminal's logs.
export class RemovalAuditService {
  constructor(private readonly logFilePath: string) {}

  async record(entry: RemovalAuditEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    // The audit line gates destructive operations ("attempt" must survive a
    // crash that happens mid-delete), so flush it to disk before returning.
    const handle = await fs.open(this.logFilePath, "a");
    try {
      await handle.appendFile(`${line}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
