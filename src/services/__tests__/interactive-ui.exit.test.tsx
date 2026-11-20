import { EventEmitter } from "node:events";
import { Console } from "node:console";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cron from "node-cron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { MOUSE_TRACKING_DISABLE, MOUSE_TRACKING_ENABLE } from "../../utils/mouse";
import { InteractiveUIService } from "../InteractiveUIService";

import type { HookExecutionService } from "../hook-execution.service";
import type { WorktreeSyncService } from "../worktree-sync.service";

const { originalCi } = vi.hoisted(() => {
  const previous = process.env.CI;
  process.env.CI = "0";
  return { originalCi: previous };
});

(globalThis.console as unknown as { Console: typeof Console }).Console = Console;

const ESC = String.fromCharCode(27);
const ENTER_ALTERNATE_SCREEN = `${ESC}[?1049h`;
const EXIT_ALTERNATE_SCREEN = `${ESC}[?1049l`;
const CTRL_C = String.fromCharCode(3);

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  readonly chunks: string[] = [];
  failWritesMatching: string | null = null;
  write = (data: string, callback?: () => void): boolean => {
    const text = String(data);
    if (this.failWritesMatching !== null && text.includes(this.failWritesMatching)) {
      throw new Error("stream refused the write");
    }
    this.chunks.push(text);
    if (typeof callback === "function") callback();
    return true;
  };
  get text(): string {
    return this.chunks.join("");
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  private pending: string | null = null;
  setRawMode = (mode: boolean): void => {
    this.rawMode = mode;
  };
  setEncoding = (): void => {};
  resume = (): void => {};
  pause = (): void => {};
  ref = (): void => {};
  unref = (): void => {};
  read = (): string | null => {
    const data = this.pending;
    this.pending = null;
    return data;
  };
  write = (data: string): void => {
    this.pending = data;
    this.emit("readable");
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 10000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
};

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

interface Harness {
  service: InteractiveUIService;
  stdout: FakeStdout;
  stdin: FakeStdin;
  exit: ReturnType<typeof vi.fn>;
  events: AppEventEmitter;
  logs: string[];
  setSyncInProgress: (value: boolean) => void;
}

describe("InteractiveUIService exit path", () => {
  let harnesses: Harness[] = [];
  let ownedTaskIds: string[] = [];

  const mount = (
    options: { syncInProgress?: boolean; stdoutIsTTY?: boolean; failWritesMatching?: string } = {},
  ): Harness => {
    let syncInProgress = options.syncInProgress ?? false;
    const syncService = {
      sync: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      isInitialized: vi.fn(() => false),
      isSyncInProgress: vi.fn(() => syncInProgress),
      updateLogger: vi.fn(),
      onProgress: vi.fn(() => vi.fn()),
      getRecordedSkips: vi.fn(() => []),
      clearRecordedSkips: vi.fn(),
      getWorktrees: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      getRemoteBranches: vi.fn<() => Promise<string[]>>().mockResolvedValue(["main"]),
      getDefaultBranch: vi.fn<() => Promise<string>>().mockResolvedValue("main"),
      config: {
        name: "test-repo",
        repoUrl: "https://example.com/repo.git",
        worktreeDir: "/tmp/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      },
    } as unknown as WorktreeSyncService;

    const stdout = new FakeStdout();
    if (options.stdoutIsTTY !== undefined) stdout.isTTY = options.stdoutIsTTY;
    if (options.failWritesMatching !== undefined) stdout.failWritesMatching = options.failWritesMatching;
    const stdin = new FakeStdin();
    const exit = vi.fn();
    const events = new AppEventEmitter();
    const logs: string[] = [];
    events.on("addLog", ({ message }) => void logs.push(message));

    const service = new InteractiveUIService([syncService], undefined, "0 * * * *", undefined, events, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exit,
    });

    const harness: Harness = {
      service,
      stdout,
      stdin,
      exit,
      events,
      logs,
      setSyncInProgress: (value: boolean): void => {
        syncInProgress = value;
      },
    };
    harnesses.push(harness);
    return harness;
  };

  const scheduleCronJobs = (service: InteractiveUIService): string[] => {
    const before = new Set(cron.getTasks().keys());
    service.setupCronJobs();
    const created = [...cron.getTasks().keys()].filter((id) => !before.has(id));
    ownedTaskIds.push(...created);
    return created;
  };

  const injectCronJob = (service: InteractiveUIService, job: cron.ScheduledTask): void => {
    (service.scheduler as unknown as { cronJobs: cron.ScheduledTask[] }).cronJobs.push(job);
  };

  beforeEach(() => {
    harnesses = [];
    ownedTaskIds = [];
  });

  afterEach(async () => {
    for (const harness of harnesses) {
      harness.setSyncInProgress(false);
      await harness.service.destroy(true);
    }
    for (const id of ownedTaskIds) {
      const task = cron.getTask(id);
      if (task) await task.destroy();
    }
    harnesses = [];
    ownedTaskIds = [];
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  describe("Ctrl+C (T42)", () => {
    it("runs the whole quit path instead of leaving a headless daemon behind", async () => {
      const harness = mount();
      const taskIds = scheduleCronJobs(harness.service);
      expect(taskIds).toHaveLength(1);
      await sleep(60);

      harness.stdin.write(CTRL_C);
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");

      expect(harness.exit.mock.calls).toEqual([[0]]);
      expect(taskIds.map((id) => cron.getTask(id))).toEqual([undefined]);
    });

    it("still quits while the help modal owns the keyboard", async () => {
      const harness = mount();
      await sleep(60);

      harness.stdin.write("?");
      await waitFor(() => harness.stdout.text.includes("Keyboard Shortcuts"), "the help modal");

      harness.stdin.write(CTRL_C);
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");
      expect(harness.exit.mock.calls).toEqual([[0]]);
    });

    it("still quits while a wizard with its own useInput owns the keyboard", async () => {
      const harness = mount();
      await sleep(60);

      harness.stdin.write("c");
      await waitFor(() => harness.stdout.text.includes("Create New Branch"), "the branch creation wizard");

      harness.stdin.write(CTRL_C);
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");
      expect(harness.exit.mock.calls).toEqual([[0]]);
    });

    it("waits for an in-progress sync before exiting, and says so on the bare terminal", async () => {
      const harness = mount({ syncInProgress: true });
      await sleep(60);

      harness.stdin.write(CTRL_C);
      await waitFor(
        () => harness.stdout.text.includes("Waiting for 1 in-progress sync(s) to finish..."),
        "the shutdown notice",
      );
      expect(harness.exit).not.toHaveBeenCalled();

      harness.setSyncInProgress(false);
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");
      expect(harness.exit.mock.calls).toEqual([[0]]);
    });
  });

  describe("mouse tracking teardown (T43)", () => {
    const assertTerminalRestored = (text: string): void => {
      const enterAlternate = text.indexOf(ENTER_ALTERNATE_SCREEN);
      const exitAlternate = text.lastIndexOf(EXIT_ALTERNATE_SCREEN);
      const enable = text.indexOf(MOUSE_TRACKING_ENABLE);
      const disable = text.lastIndexOf(MOUSE_TRACKING_DISABLE);

      expect(enterAlternate).toBeGreaterThanOrEqual(0);
      expect(exitAlternate).toBeGreaterThan(enterAlternate);

      expect(occurrences(text, MOUSE_TRACKING_ENABLE)).toBe(1);
      expect(occurrences(text, MOUSE_TRACKING_DISABLE)).toBe(1);
      expect(enable).toBeGreaterThan(enterAlternate);
      expect(disable).toBeGreaterThan(exitAlternate);
    };

    it("disables tracking after Ink leaves the alternate screen on the q path", async () => {
      const harness = mount();
      await sleep(60);

      harness.stdin.write("q");
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");

      assertTerminalRestored(harness.stdout.text);
    });

    it("disables tracking after Ink leaves the alternate screen on the Ctrl+C path", async () => {
      const harness = mount();
      await sleep(60);

      harness.stdin.write(CTRL_C);
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");

      assertTerminalRestored(harness.stdout.text);
    });

    it("disables tracking on the signal path the CLI registers", async () => {
      const harness = mount();
      await sleep(60);

      await harness.service.destroy(true);

      assertTerminalRestored(harness.stdout.text);
    });

    it("arms a process exit listener for the paths that never reach teardown", async () => {
      const before = process.listenerCount("exit");
      const harness = mount();
      await sleep(60);

      expect(process.listenerCount("exit")).toBe(before + 1);

      await harness.service.destroy(true);
      expect(process.listenerCount("exit")).toBe(before);
    });

    it("writes no tracking sequence, and arms no exit listener, when stdout is not a terminal", async () => {
      const before = process.listenerCount("exit");
      const harness = mount({ stdoutIsTTY: false });
      await sleep(60);

      expect(process.listenerCount("exit")).toBe(before);

      await harness.service.destroy(true);

      expect(occurrences(harness.stdout.text, MOUSE_TRACKING_ENABLE)).toBe(0);
      expect(occurrences(harness.stdout.text, MOUSE_TRACKING_DISABLE)).toBe(0);
      expect(process.listenerCount("exit")).toBe(before);
    });
  });

  describe("shutdown progress and force quit (T107)", () => {
    it("shows the wait notice in the log panel on the q path", async () => {
      const harness = mount({ syncInProgress: true });
      await sleep(60);
      harness.logs.length = 0;

      harness.stdin.write("q");
      await waitFor(
        () => harness.logs.some((line) => line.startsWith("Waiting for 1 in-progress sync(s) to finish...")),
        "the wait notice in the log panel",
      );

      harness.setSyncInProgress(false);
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");
    });

    it("a second q ends the wait early instead of hanging for the full timeout", async () => {
      const harness = mount({ syncInProgress: true });
      await sleep(60);
      harness.logs.length = 0;

      harness.stdin.write("q");
      await waitFor(
        () => harness.logs.some((line) => line.includes("Press q or Ctrl+C again to quit now.")),
        "the wait notice",
      );

      await sleep(600);
      harness.stdin.write("q");

      await waitFor(() => harness.exit.mock.calls.length > 0, "the forced exit", 5000);
      expect(harness.logs).toContain("Force quit: leaving in-progress sync(s) unfinished.");
      expect([...new Set(harness.exit.mock.calls.map(([code]) => code))]).toEqual([0]);
    });

    it("Ctrl+C on top of the wait q started ends it too", async () => {
      const harness = mount({ syncInProgress: true });
      await sleep(60);
      harness.logs.length = 0;

      harness.stdin.write("q");
      await waitFor(
        () => harness.logs.some((line) => line.includes("Press q or Ctrl+C again to quit now.")),
        "the wait notice",
      );

      await sleep(600);
      harness.stdin.write(CTRL_C);

      await waitFor(() => harness.exit.mock.calls.length > 0, "the forced exit", 5000);
      expect(harness.logs).toContain("Force quit: leaving in-progress sync(s) unfinished.");
      expect(harness.stdout.text).toContain("Force quit: leaving in-progress sync(s) unfinished.\n");
    });
  });

  describe("cron task lifetime (T117)", () => {
    it("releases tasks from node-cron's registry rather than only stopping them", async () => {
      const harness = mount();
      const [taskId] = scheduleCronJobs(harness.service);
      const task = cron.getTask(taskId);
      expect(task).toBeDefined();
      expect(task?.getStatus()).not.toBe("destroyed");

      await harness.service.destroy(true);

      expect(cron.getTask(taskId)).toBeUndefined();
      expect(task?.getStatus()).toBe("destroyed");
    });

    it("reports a task whose destroy rejects instead of crashing the process", async () => {
      const harness = mount();
      await sleep(60);
      harness.logs.length = 0;

      injectCronJob(harness.service, {
        stop: vi.fn(),
        destroy: vi.fn(() => Promise.reject(new Error("Destroy operation timed out"))),
      } as unknown as cron.ScheduledTask);

      await harness.service.destroy(true);
      await sleep(20);

      expect(harness.logs).toContain("Failed to release cron task: Destroy operation timed out");
    });

    it("reports a task whose destroy throws and still releases the ones behind it", async () => {
      const harness = mount();
      await sleep(60);
      harness.logs.length = 0;

      injectCronJob(harness.service, {
        stop: vi.fn(),
        destroy: (): never => {
          throw new Error("task already gone");
        },
      } as unknown as cron.ScheduledTask);
      const [taskId] = scheduleCronJobs(harness.service);
      expect(cron.getTask(taskId)).toBeDefined();

      await harness.service.destroy(true);

      expect(harness.logs).toContain("Failed to release cron task: task already gone");
      expect(cron.getTask(taskId)).toBeUndefined();
    });

    it("does not turn a late destroy rejection into an unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const record = (reason: unknown): void => void unhandled.push(reason);
      process.on("unhandledRejection", record);
      try {
        const harness = mount();
        await sleep(60);

        injectCronJob(harness.service, {
          stop: vi.fn(),
          destroy: (): Promise<void> =>
            new Promise<void>((_resolve, reject) =>
              setTimeout(() => reject(new Error("Destroy operation timed out")), 60),
            ),
        } as unknown as cron.ScheduledTask);

        await harness.service.destroy(true);
        await sleep(250);

        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", record);
      }
    });
  });

  describe("hooks on quit (T110)", () => {
    const fixtureDirs: string[] = [];
    const PROC_AVAILABLE = fs.existsSync("/proc/self/stat");

    afterEach(() => {
      for (const dir of fixtureDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      if (!PROC_AVAILABLE) return true;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch {
        return false;
      }
    };

    const startRealHook = async (service: InteractiveUIService): Promise<{ command: string; pid: number }> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-hook-"));
      fixtureDirs.push(dir);
      const pidFile = JSON.stringify(path.join(dir, "pid"));
      const body = `const fs=require('fs');fs.writeFileSync(${pidFile},String(process.pid));setInterval(()=>{},20);`;
      const command = `"${process.execPath}" -e "${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

      (
        service as unknown as { hookExecutionService: HookExecutionService }
      ).hookExecutionService.executeOnBranchCreated(
        { onBranchCreated: [command], timeoutMs: 0 },
        {
          branchName: "feature/x",
          worktreePath: dir,
          repoName: "test-repo",
          baseBranch: "main",
          repoUrl: "https://example.com/repo.git",
        },
      );

      await waitFor(
        () => fs.existsSync(path.join(dir, "pid")) && fs.readFileSync(path.join(dir, "pid"), "utf8") !== "",
        "the hook to report its pid",
      );
      return { command, pid: Number(fs.readFileSync(path.join(dir, "pid"), "utf8")) };
    };

    it("terminates the hook and says which one, on the primary buffer the shell gets back", async () => {
      const harness = mount();
      await sleep(60);
      const { command, pid } = await startRealHook(harness.service);
      expect(isAlive(pid)).toBe(true);

      harness.stdin.write("q");
      await waitFor(
        () => harness.stdout.text.includes("1 hook still running — press q again to quit"),
        "the quit confirmation",
      );
      expect(harness.exit).not.toHaveBeenCalled();
      expect(isAlive(pid)).toBe(true);

      harness.stdin.write("q");
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");

      await waitFor(() => !isAlive(pid), "the hook process to go away");

      const text = harness.stdout.text;
      const exitAlternate = text.lastIndexOf(EXIT_ALTERNATE_SCREEN);
      expect(exitAlternate).toBeGreaterThanOrEqual(0);

      const summary = "Terminating 1 hook(s) still running; hooks do not outlive the interface:";
      const named = `[hook] terminated on exit: ${command}`;
      expect(text.lastIndexOf(summary)).toBeGreaterThan(exitAlternate);
      expect(text.lastIndexOf(named)).toBeGreaterThan(exitAlternate);

      expect(harness.logs).toEqual(expect.arrayContaining([summary, named]));
    });

    it("finishes the quit when the stream refuses one of the lines", async () => {
      const harness = mount({ failWritesMatching: "terminated on exit" });
      await sleep(60);
      const { pid } = await startRealHook(harness.service);

      harness.stdin.write("q");
      await waitFor(() => harness.stdout.text.includes("press q again to quit"), "the quit confirmation");
      harness.stdin.write("q");
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");

      expect(harness.exit).toHaveBeenCalledWith(0);
      expect(harness.logs.filter((line) => line.startsWith("Shutdown failed"))).toEqual([]);
      expect(harness.stdout.text).toContain("hook(s) still running");
      await waitFor(() => !isAlive(pid), "the hook process to go away");
    });

    it("says nothing about hooks when none were running", async () => {
      const harness = mount();
      await sleep(60);

      harness.stdin.write("q");
      await waitFor(() => harness.exit.mock.calls.length > 0, "the process to be asked to exit");

      expect(harness.stdout.text).not.toContain("terminated on exit");
      expect(harness.stdout.text).not.toContain("hook(s) still running");
      expect(harness.logs.filter((line) => line.includes("hook"))).toEqual([]);
    });
  });
});
