import * as fs from "fs/promises";
import * as path from "path";

import type { WorktreeStatusResult } from "./worktree-status.service";

export type RemovalAuditAction =
  | "prune_remove"
  | "orphan_delete"
  | "orphan_quarantine"
  | "diverged_replace"
  | "manual_remove"
  | "trash_create"
  | "trash_adopt"
  | "trash_restore"
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

// Append-only JSONL log of every destructive worktree operation. Console logs
// die with the terminal; this record survives the process.
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
