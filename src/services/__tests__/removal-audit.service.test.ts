import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RemovalAuditService } from "../removal-audit.service";

import type { Mock } from "vitest";

vi.mock("fs/promises");

describe("RemovalAuditService", () => {
  const logFile = path.join("/test/state", "repo-removals.jsonl");
  let service: RemovalAuditService;
  let mockFileHandle: { appendFile: Mock<any>; sync: Mock<any>; close: Mock<any> };

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
    // record opens the log file and fsyncs each line — "attempt" entries gate
    // destructive ops, so durability matters more than appendFile convenience.
    mockFileHandle = {
      appendFile: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    (fs.open as Mock<any>).mockResolvedValue(mockFileHandle);
    service = new RemovalAuditService(logFile);
  });

  it("appends one JSON line per record", async () => {
    await service.record({
      action: "prune_remove",
      result: "attempt",
      path: "/test/worktrees/old-branch",
      branch: "old-branch",
    });

    expect(fs.open).toHaveBeenCalledWith(logFile, "a");
    expect(mockFileHandle.appendFile).toHaveBeenCalledTimes(1);
    const [payload] = mockFileHandle.appendFile.mock.calls[0] as [string];
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

  it("flushes the line to disk before returning", async () => {
    await service.record({ action: "prune_remove", result: "attempt", path: "/test/worktrees/old-branch" });

    expect(mockFileHandle.sync).toHaveBeenCalledTimes(1);
    expect(mockFileHandle.close).toHaveBeenCalledTimes(1);
  });

  it("creates the log directory before appending", async () => {
    await service.record({ action: "orphan_delete", result: "success", path: "/test/worktrees/orphan" });

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(logFile), { recursive: true });
  });

  it("propagates write failures so callers can fail closed", async () => {
    mockFileHandle.appendFile.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

    await expect(
      service.record({ action: "prune_remove", result: "attempt", path: "/test/worktrees/old-branch" }),
    ).rejects.toThrow("EACCES");
    expect(mockFileHandle.close).toHaveBeenCalled();
  });
});
