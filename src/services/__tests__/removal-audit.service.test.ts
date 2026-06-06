import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RemovalAuditService } from "../removal-audit.service";

import type { Mock } from "vitest";

vi.mock("fs/promises");

describe("RemovalAuditService", () => {
  const logFile = path.join("/test/state", "repo-removals.jsonl");
  let service: RemovalAuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
    (fs.appendFile as Mock<any>).mockResolvedValue(undefined);
    service = new RemovalAuditService(logFile);
  });

  it("appends one JSON line per record", async () => {
    await service.record({
      action: "prune_remove",
      result: "attempt",
      path: "/test/worktrees/old-branch",
      branch: "old-branch",
    });

    expect(fs.appendFile).toHaveBeenCalledTimes(1);
    const [target, payload] = (fs.appendFile as Mock<any>).mock.calls[0] as [string, string];
    expect(target).toBe(logFile);
    expect(payload.endsWith("\n")).toBe(true);
    const entry = JSON.parse(payload.trim());
    expect(entry).toMatchObject({
      action: "prune_remove",
      result: "attempt",
      path: "/test/worktrees/old-branch",
      branch: "old-branch",
    });
    expect(typeof entry.timestamp).toBe("string");
  });

  it("creates the log directory before appending", async () => {
    await service.record({ action: "orphan_delete", result: "success", path: "/test/worktrees/orphan" });

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(logFile), { recursive: true });
  });

  it("propagates write failures so callers can fail closed", async () => {
    (fs.appendFile as Mock<any>).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

    await expect(
      service.record({ action: "prune_remove", result: "attempt", path: "/test/worktrees/old-branch" }),
    ).rejects.toThrow("EACCES");
  });
});
