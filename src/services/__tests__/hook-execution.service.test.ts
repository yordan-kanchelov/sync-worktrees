import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, HOOK_CONSTANTS } from "../../constants";
import { setEnvVar } from "../../__tests__/test-utils";
import { HookExecutionService } from "../hook-execution.service";

import type { HookContext, HooksConfig } from "../../types";
import type { HookExecutionCallbacks } from "../hook-execution.service";

const NODE = process.execPath;

const nodeScript = (body: string): string => `"${NODE}" -e "${body.replace(/"/g, '\\"')}"`;

describe("HookExecutionService", () => {
  let service: HookExecutionService;
  let mockContext: HookContext;

  const runAndWait = (
    hooks: HooksConfig,
    context: HookContext,
    callbacks: HookExecutionCallbacks = {},
  ): Promise<void> => {
    const total = hooks.onBranchCreated?.length ?? 0;
    if (total === 0) {
      service.executeOnBranchCreated(hooks, context, callbacks);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = 0;
      const userComplete = callbacks.onComplete;
      service.executeOnBranchCreated(hooks, context, {
        ...callbacks,
        onComplete: (command, exitCode) => {
          userComplete?.(command, exitCode);
          if (++done === total) resolve();
        },
      });
    });
  };

  beforeEach(() => {
    service = new HookExecutionService();
    mockContext = {
      branchName: "feature/test-branch",
      worktreePath: "/tmp",
      repoName: "test-repo",
      baseBranch: "main",
      repoUrl: "https://github.com/test/repo.git",
    };
  });

  // Real children, probed by pid. Whether a hook is alive after cleanup() is
  // the whole of T110, and "kill was called" is not that: the service kills a
  // process GROUP through a shell it does not own, so only asking the OS about
  // the pid the hook itself reported proves the signal reached the work.
  let fixtureDirs: string[] = [];

  const makeFixtureDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-exec-"));
    fixtureDirs.push(dir);
    return dir;
  };

  // A hook that records its own pid, then ticks a file forever. The pid is the
  // node grandchild's, not the shell the service spawned, so a test that finds
  // it gone has watched the group kill travel all the way down.
  const livenessHook = (dir: string): string => {
    const pidFile = JSON.stringify(path.join(dir, "pid"));
    const tickFile = JSON.stringify(path.join(dir, "ticks"));
    return nodeScript(
      `const fs=require('fs');fs.writeFileSync(${pidFile},String(process.pid));` +
        `setInterval(()=>fs.appendFileSync(${tickFile},'x'),20);`,
    );
  };

  const readReportedPid = async (dir: string): Promise<number> => {
    const pidFile = path.join(dir, "pid");
    await vi.waitFor(() => {
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, "utf8").length).toBeGreaterThan(0);
    });
    return Number(fs.readFileSync(pidFile, "utf8"));
  };

  // "Gone" has two shapes and only one of them is an ESRCH. A killed orphan is
  // reparented to pid 1 and stays in the process table as a zombie until
  // something reaps it, which the container these tests run in does not do, so
  // `kill(pid, 0)` goes on succeeding for a process that stopped running long
  // ago. Where /proc can settle it, read the state; elsewhere (macOS, whose
  // launchd does reap) ESRCH is the answer on its own.
  const PROC_AVAILABLE = fs.existsSync("/proc/self/stat");

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

  const tickCount = (dir: string): number => {
    try {
      return fs.readFileSync(path.join(dir, "ticks"), "utf8").length;
    } catch {
      return 0;
    }
  };

  afterEach(async () => {
    await service.cleanup();
    for (const dir of fixtureDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fixtureDirs = [];
  });

  describe("executeOnBranchCreated", () => {
    it("should do nothing when hooks is undefined", () => {
      expect(() => service.executeOnBranchCreated(undefined, mockContext)).not.toThrow();
    });

    it("should do nothing when hooks object is empty", () => {
      expect(() => service.executeOnBranchCreated({}, mockContext)).not.toThrow();
    });

    it("should do nothing when onBranchCreated is empty array", () => {
      expect(() => service.executeOnBranchCreated({ onBranchCreated: [] }, mockContext)).not.toThrow();
    });

    it("should execute commands with correct environment variables", async () => {
      const stdoutCallback = vi.fn();

      await runAndWait(
        {
          onBranchCreated: [nodeScript(`process.stdout.write(process.env['${HOOK_CONSTANTS.ENV_VARS.BRANCH_NAME}'])`)],
        },
        mockContext,
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).toHaveBeenCalledWith(expect.stringContaining("feature/test-branch"));
    });

    it("should execute commands with correct environment variables for all context fields", async () => {
      const stdoutCallback = vi.fn();

      await runAndWait(
        {
          onBranchCreated: [
            nodeScript(
              `process.stdout.write([process.env['${HOOK_CONSTANTS.ENV_VARS.BRANCH_NAME}'], process.env['${HOOK_CONSTANTS.ENV_VARS.REPO_NAME}'], process.env['${HOOK_CONSTANTS.ENV_VARS.BASE_BRANCH}']].join(','))`,
            ),
          ],
        },
        mockContext,
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).toHaveBeenCalledWith("feature/test-branch,test-repo,main");
    });

    // Hook commands run with the new worktree as their cwd, which is all that
    // tells them which repository they are in. A run started from a git hook in
    // a linked worktree inherits that worktree's GIT_DIR (git exports it), and a
    // shell or CI job can export any of the rest, so without this strip every
    // `git` in a hook command would work on that repository instead.
    it("does not pass on an inherited repository-selection variable", async () => {
      const stdoutCallback = vi.fn();
      const originalGitDir = process.env.GIT_DIR;
      const originalIndexFile = process.env.GIT_INDEX_FILE;
      process.env.GIT_DIR = "/elsewhere/.git";
      process.env.GIT_INDEX_FILE = ".git/index";

      try {
        await runAndWait(
          {
            onBranchCreated: [
              nodeScript(
                `process.stdout.write([process.env.GIT_DIR ?? 'unset', process.env.GIT_INDEX_FILE ?? 'unset', process.env['${HOOK_CONSTANTS.ENV_VARS.REPO_NAME}']].join(','))`,
              ),
            ],
          },
          mockContext,
          { onStdout: stdoutCallback },
        );
      } finally {
        setEnvVar("GIT_DIR", originalGitDir);
        setEnvVar("GIT_INDEX_FILE", originalIndexFile);
      }

      expect(stdoutCallback).toHaveBeenCalledWith("unset,unset,test-repo");
    });

    it("hands hooks the working repository URL, credentials included, via the environment", async () => {
      const stdoutCallback = vi.fn();
      const tokenUrl = "https://ci-bot:s3cr3t-token@github.com/test/repo.git";

      await runAndWait(
        {
          onBranchCreated: [nodeScript(`process.stdout.write(process.env['${HOOK_CONSTANTS.ENV_VARS.REPO_URL}'])`)],
        },
        { ...mockContext, repoUrl: tokenUrl },
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).toHaveBeenCalledWith(tokenUrl);
    });

    it.each([
      {
        desc: "two placeholders",
        template:
          nodeScript("process.stdout.write([process.argv[1], process.argv[2]].join(' '))") +
          " {BRANCH_NAME} {WORKTREE_PATH}",
        expected: "feature/test-branch /tmp",
      },
      {
        desc: "three placeholders",
        template:
          nodeScript("process.stdout.write([process.argv[1], process.argv[2], process.argv[3]].join(' '))") +
          " {BRANCH_NAME} {REPO_NAME} {BASE_BRANCH}",
        expected: "feature/test-branch test-repo main",
      },
      {
        desc: "repeated placeholder",
        template:
          nodeScript("process.stdout.write([process.argv[1], process.argv[2], process.argv[3]].join(' '))") +
          " {BRANCH_NAME} {BRANCH_NAME} {BRANCH_NAME}",
        expected: "feature/test-branch feature/test-branch feature/test-branch",
      },
    ])("should replace placeholders correctly ($desc)", async ({ template, expected }) => {
      const stdoutCallback = vi.fn();

      await runAndWait({ onBranchCreated: [template] }, mockContext, { onStdout: stdoutCallback });

      expect(stdoutCallback).toHaveBeenCalledWith(expected);
    });

    it("should call onComplete callback when command succeeds", async () => {
      const completeCallback = vi.fn();
      const command = nodeScript("process.stdout.write('success')");

      await runAndWait({ onBranchCreated: [command] }, mockContext, { onComplete: completeCallback });

      expect(completeCallback).toHaveBeenCalledWith(command, 0);
    });

    it("should call onComplete with non-zero exit code for failing command", async () => {
      const completeCallback = vi.fn();
      const command = nodeScript("process.exit(1)");

      await runAndWait({ onBranchCreated: [command] }, mockContext, { onComplete: completeCallback });

      expect(completeCallback).toHaveBeenCalledWith(command, 1);
    });

    it("should call onStderr for commands that write to stderr", async () => {
      const stderrCallback = vi.fn();

      await runAndWait({ onBranchCreated: [nodeScript("process.stderr.write('error')")] }, mockContext, {
        onStderr: stderrCallback,
      });

      expect(stderrCallback).toHaveBeenCalledWith("error");
    });

    it("should execute multiple commands independently", async () => {
      const stdoutCallback = vi.fn();

      await runAndWait(
        {
          onBranchCreated: [
            nodeScript("process.stdout.write('first')"),
            nodeScript("process.stdout.write('second')"),
            nodeScript("process.stdout.write('third')"),
          ],
        },
        mockContext,
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).toHaveBeenCalledTimes(3);
      expect(stdoutCallback).toHaveBeenCalledWith("first");
      expect(stdoutCallback).toHaveBeenCalledWith("second");
      expect(stdoutCallback).toHaveBeenCalledWith("third");
    });

    it("should not block when command takes long time", async () => {
      const startTime = Date.now();

      service.executeOnBranchCreated({ onBranchCreated: [nodeScript("setTimeout(() => {}, 5000)")] }, mockContext);

      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);

      await service.cleanup();
    });

    it("should handle commands with special characters in context", async () => {
      const stdoutCallback = vi.fn();

      const contextWithSpecialChars: HookContext = {
        ...mockContext,
        branchName: "feature/test-with-special-chars",
        worktreePath: "/tmp",
      };

      await runAndWait(
        {
          onBranchCreated: [nodeScript("process.stdout.write(process.argv[1])") + " {BRANCH_NAME}"],
        },
        contextWithSpecialChars,
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).toHaveBeenCalledWith("feature/test-with-special-chars");
    });

    it("should not call callbacks for empty output", async () => {
      const stdoutCallback = vi.fn();

      await runAndWait({ onBranchCreated: [nodeScript("process.exit(0)")] }, mockContext, { onStdout: stdoutCallback });

      expect(stdoutCallback).not.toHaveBeenCalled();
    });

    it("should pass both env vars and placeholders work in same command", async () => {
      const stdoutCallback = vi.fn();

      await runAndWait(
        {
          onBranchCreated: [
            nodeScript(
              `process.stdout.write(process.argv[1] + ' ' + process.env['${HOOK_CONSTANTS.ENV_VARS.REPO_NAME}'])`,
            ) + " {BRANCH_NAME}",
          ],
        },
        mockContext,
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).toHaveBeenCalledWith("feature/test-branch test-repo");
    });

    it("should prevent shell injection via placeholders", async () => {
      const stdoutCallback = vi.fn();

      const maliciousContext: HookContext = {
        ...mockContext,
        branchName: "'; echo INJECTED; '",
      };

      await runAndWait(
        {
          onBranchCreated: [nodeScript("process.stdout.write(process.argv[1])") + " {BRANCH_NAME}"],
        },
        maliciousContext,
        { onStdout: stdoutCallback },
      );

      expect(stdoutCallback).not.toHaveBeenCalledWith("INJECTED");
      expect(stdoutCallback).toHaveBeenCalledWith("'; echo INJECTED; '");
    });

    it("should clean up active processes", async () => {
      service.executeOnBranchCreated({ onBranchCreated: [nodeScript("setTimeout(() => {}, 10000)")] }, mockContext);

      await new Promise((resolve) => setTimeout(resolve, 100));

      await service.cleanup();

      expect((service as any).activeProcesses.size).toBe(0);
    });

    it("should execute command with worktree path as cwd", async () => {
      const stdoutCallback = vi.fn();

      const contextWithTmpPath: HookContext = {
        ...mockContext,
        worktreePath: "/tmp",
      };

      await runAndWait({ onBranchCreated: [nodeScript("process.stdout.write(process.cwd())")] }, contextWithTmpPath, {
        onStdout: stdoutCallback,
      });

      expect(stdoutCallback).toHaveBeenCalledWith(expect.stringContaining("tmp"));
    });

    it("should track active processes and remove on completion", async () => {
      await runAndWait({ onBranchCreated: [nodeScript("process.stdout.write('done')")] }, mockContext);

      expect((service as any).activeProcesses.size).toBe(0);
    });

    it("should call onError callback when command times out", async () => {
      const errorCallback = vi.fn();
      const command = nodeScript("setTimeout(() => {}, 10000)");

      try {
        service.executeOnBranchCreated({ onBranchCreated: [command], timeoutMs: 100 }, mockContext, {
          onError: errorCallback,
        });

        await vi.waitFor(() => {
          expect(errorCallback).toHaveBeenCalledWith(
            command,
            expect.objectContaining({
              message: expect.stringContaining("timed out"),
            }),
          );
        });
      } finally {
        await service.cleanup();
      }
    });

    it("should clear the SIGKILL timer after a timed-out hook exits", async () => {
      const command = nodeScript("setInterval(() => {}, 1000)");

      try {
        service.executeOnBranchCreated({ onBranchCreated: [command], timeoutMs: 100 }, mockContext);

        await vi.waitFor(() => {
          expect((service as any).killTimers.size).toBe(0);
          expect((service as any).activeProcesses.size).toBe(0);
        });
      } finally {
        await service.cleanup();
      }
    });
  });

  describe("cleanup reports what it terminated (T110)", () => {
    it("really kills the hook and returns the command it killed", async () => {
      const dir = makeFixtureDir();
      const command = livenessHook(dir);

      service.executeOnBranchCreated({ onBranchCreated: [command] }, mockContext);
      const pid = await readReportedPid(dir);
      expect(isAlive(pid)).toBe(true);

      const terminated = await service.cleanup();

      // The identity of what was killed, not a count: the user has to be able
      // to read which of their commands the quit ended.
      expect(terminated).toEqual([command]);

      // The outcome, not the call: the pid the hook reported is gone from the
      // process table, and it has stopped doing work.
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false);
      });
      const settled = tickCount(dir);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(tickCount(dir)).toBe(settled);
    });

    it("names every running hook, and only the ones still running", async () => {
      const running = makeFixtureDir();
      const longHook = livenessHook(running);
      const shortHook = nodeScript("process.stdout.write('done')");

      const finished = new Promise<void>((resolve) => {
        service.executeOnBranchCreated({ onBranchCreated: [shortHook, longHook] }, mockContext, {
          onComplete: (command) => {
            if (command === shortHook) resolve();
          },
        });
      });
      await finished;
      const pid = await readReportedPid(running);

      expect(await service.cleanup()).toEqual([longHook]);
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false);
      });
    });

    it("returns an empty list when no hook is running", async () => {
      expect(await service.cleanup()).toEqual([]);
    });

    // F1. The deliberate SIGTERM is the whole argument for killing rather than
    // orphaning, and it is worth nothing if the trap does not get to run. It
    // does not, unless cleanup() holds the process open for it: the quit calls
    // exitProcess in the statement after this resolves, which closes the pipes
    // the hook holds as stdout and stderr, and a trap that prints anything is
    // SIGPIPEd part-way through. Measured directly against the real quit path:
    // a trap writing only to files completed, the same trap with one echo in it
    // died between its first and second line.
    it("resolves only once a hook trapping SIGTERM has finished its trap", async () => {
      const dir = makeFixtureDir();
      const trapFile = path.join(dir, "trap");
      const readyFile = path.join(dir, "ready");
      // The echoes are the point: they are what a bare exit turns into SIGPIPE.
      const command =
        `trap 'echo caught; echo one >> "${trapFile}"; sleep 0.05; echo still-here; ` +
        `echo two >> "${trapFile}"; exit 0' TERM; echo ready > "${readyFile}"; ` +
        `while true; do sleep 0.05; done`;

      service.executeOnBranchCreated({ onBranchCreated: [command], timeoutMs: 0 }, mockContext);
      await vi.waitFor(() => {
        expect(fs.existsSync(readyFile)).toBe(true);
      });

      const started = Date.now();
      expect(await service.cleanup()).toEqual([command]);

      // Read with no waitFor: the guarantee is that the trap is already done
      // when cleanup resolves, because that is the instant the caller exits.
      // Missing reads as no lines rather than as an ENOENT, so a cleanup that
      // came back too early says so as a value.
      const trapLines = (): string[] => {
        try {
          return fs.readFileSync(trapFile, "utf8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      };
      expect(trapLines()).toEqual(["one", "two"]);
      // And the wait is bounded, so quit latency stays a quit latency.
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("comes back quickly when the hook has no trap to run", async () => {
      const dir = makeFixtureDir();
      service.executeOnBranchCreated({ onBranchCreated: [livenessHook(dir)], timeoutMs: 0 }, mockContext);
      await readReportedPid(dir);

      // The grace is an upper bound, not a sleep: a hook killed by the default
      // action closes its pipes at once and the quit goes straight on.
      const started = Date.now();
      await service.cleanup();
      expect(Date.now() - started).toBeLessThan(200);
    });

    // F4. The 5s SIGKILL this used to arm could never fire - the quit exits in
    // the statement after cleanup() returns - so a hook that ignored SIGTERM
    // was orphaned permanently and had to be killed by hand.
    it("SIGKILLs a hook that ignores SIGTERM rather than orphaning it", async () => {
      const dir = makeFixtureDir();
      const pidFile = JSON.stringify(path.join(dir, "pid"));
      // `; true` keeps the shell from exec'ing into node, so this is the shape
      // the escalation has to survive: the shell dies on the first SIGTERM and
      // a grandchild that ignored it goes on holding the pipes. The shell's own
      // exitCode says "dead" there, which is why the wait watches the streams.
      const command =
        nodeScript(
          `const fs=require('fs');process.on('SIGTERM',()=>{});` +
            `fs.writeFileSync(${pidFile},String(process.pid));setInterval(()=>{},50);`,
        ) + "; true";

      service.executeOnBranchCreated({ onBranchCreated: [command], timeoutMs: 0 }, mockContext);
      const pid = await readReportedPid(dir);
      expect(isAlive(pid)).toBe(true);

      expect(await service.cleanup()).toEqual([command]);
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false);
      });
    });

    // F2. cleanup() used to push the command before signalling, and
    // terminateChild swallowed every failure, so the quit could name a hook it
    // never touched. A hook that exits just before the quit is still in the map
    // - its close event is queued behind the keystroke - and killing its group
    // answers ESRCH.
    it("does not name a hook that had already exited", async () => {
      const dead = spawn(nodeScript("process.exit(0)"), {
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      dead.stdout?.on("data", () => {});
      dead.stderr?.on("data", () => {});
      await new Promise<void>((resolve) => dead.once("close", () => resolve()));

      // A real, really-dead pid put back where a queued close event would have
      // left it. Nothing here is a double: the ESRCH comes from the kernel.
      (service as any).activeProcesses.set(dead, "already-finished-hook");

      expect(await service.cleanup()).toEqual([]);
      expect((service as any).activeProcesses.size).toBe(0);
    });

    it("names the live hook and omits the dead one in the same sweep", async () => {
      const dir = makeFixtureDir();
      const live = livenessHook(dir);
      const dead = spawn(nodeScript("process.exit(0)"), {
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      dead.stdout?.on("data", () => {});
      dead.stderr?.on("data", () => {});
      await new Promise<void>((resolve) => dead.once("close", () => resolve()));

      service.executeOnBranchCreated({ onBranchCreated: [live], timeoutMs: 0 }, mockContext);
      const pid = await readReportedPid(dir);
      (service as any).activeProcesses.set(dead, "already-finished-hook");

      expect(await service.cleanup()).toEqual([live]);
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false);
      });
    });
  });

  describe("configurable timeout (T114)", () => {
    it("uses hooks.timeoutMs in place of the built-in default", async () => {
      const errorCallback = vi.fn();
      const command = nodeScript("setInterval(() => {}, 1000)");

      service.executeOnBranchCreated({ onBranchCreated: [command], timeoutMs: 100 }, mockContext, {
        onError: errorCallback,
      });

      await vi.waitFor(() => {
        expect(errorCallback).toHaveBeenCalledWith(
          command,
          expect.objectContaining({ message: "Hook timed out after 100ms" }),
        );
      });
    });

    it("arms no timer at all for timeoutMs 0, while the hook is still running", async () => {
      const dir = makeFixtureDir();
      const errorCallback = vi.fn();

      service.executeOnBranchCreated({ onBranchCreated: [livenessHook(dir)], timeoutMs: 0 }, mockContext, {
        onError: errorCallback,
      });
      const pid = await readReportedPid(dir);
      expect(isAlive(pid)).toBe(true);

      // Asserted while the hook runs, which is the only moment the two failures
      // look different: `||` in place of `??` would arm the 60s default here,
      // and a timer that is merely cleared on close is indistinguishable from
      // one that was never created once the hook has exited.
      expect((service as any).timeoutTimers.size).toBe(0);
      expect(errorCallback).not.toHaveBeenCalled();
    });

    it("lets a timeoutMs 0 hook run past the shipped default and complete normally", async () => {
      const errorCallback = vi.fn();
      const completeCallback = vi.fn();

      service.executeOnBranchCreated(
        { onBranchCreated: [nodeScript("setTimeout(() => process.exit(0), 300)")], timeoutMs: 0 },
        mockContext,
        { onError: errorCallback, onComplete: completeCallback },
      );

      await vi.waitFor(
        () => {
          expect(completeCallback).toHaveBeenCalledTimes(1);
        },
        { timeout: 5000 },
      );
      expect(completeCallback.mock.calls[0]?.[1]).toBe(0);
      expect(errorCallback).not.toHaveBeenCalled();
    });

    it("carries the timeout per call, so one service can serve repositories that differ", async () => {
      const errors: string[] = [];
      const impatient = nodeScript("setInterval(() => {}, 1000)");
      const patient = nodeScript("setTimeout(() => process.exit(0), 300)");

      service.executeOnBranchCreated({ onBranchCreated: [impatient], timeoutMs: 60 }, mockContext, {
        onError: (_command, error) => void errors.push(error.message),
      });
      const completed = new Promise<void>((resolve) => {
        service.executeOnBranchCreated({ onBranchCreated: [patient], timeoutMs: 0 }, mockContext, {
          onComplete: () => resolve(),
        });
      });

      await completed;
      expect(errors).toEqual(["Hook timed out after 60ms"]);
    });

    it("falls back to the shipped default when no timeoutMs is configured", async () => {
      const dir = makeFixtureDir();
      service.executeOnBranchCreated({ onBranchCreated: [livenessHook(dir)] }, mockContext);
      await readReportedPid(dir);

      const timers = [...(service as any).timeoutTimers] as { _idleTimeout?: number }[];
      expect(timers).toHaveLength(1);
      expect(timers[0]?._idleTimeout).toBe(DEFAULT_CONFIG.HOOK_TIMEOUT_MS);
    });
  });
});
