import * as fs from "fs/promises";
import * as path from "path";

import type { WorktreeStatusResult } from "./worktree-status.service";

export type RemovalAuditAction =
  | "prune_remove"
  | "orphan_delete"
  | "orphan_quarantine"
  | "diverged_replace"
  | "manual_remove";

export interface RemovalAuditEntry {
  action: RemovalAuditAction;
  result: "attempt" | "success" | "failure";
  path: string;
  branch?: string;
  status?: WorktreeStatusResult;
  quarantinePath?: string;
  error?: string;
}

// Append-only JSONL log of every destructive worktree operation. Console logs
// die with the terminal; this record survives the process.
export class RemovalAuditService {
  constructor(private readonly logFilePath: string) {}

  async record(entry: RemovalAuditEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    await fs.appendFile(this.logFilePath, `${line}\n`, "utf-8");
  }
}
