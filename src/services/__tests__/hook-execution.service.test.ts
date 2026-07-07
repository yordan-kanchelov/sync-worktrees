import { beforeEach, describe, expect, it, vi } from "vitest";

import { HOOK_CONSTANTS } from "../../constants";
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

    it("should not block when command takes long time", () => {
      const startTime = Date.now();

      service.executeOnBranchCreated({ onBranchCreated: [nodeScript("setTimeout(() => {}, 5000)")] }, mockContext);

      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);

      service.cleanup();
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

      service.cleanup();

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

      service.setTimeoutMs(100);

      try {
        service.executeOnBranchCreated({ onBranchCreated: [command] }, mockContext, {
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
        service.cleanup();
      }
    });

    it("should clear the SIGKILL timer after a timed-out hook exits", async () => {
      const command = nodeScript("setInterval(() => {}, 1000)");

      service.setTimeoutMs(100);

      try {
        service.executeOnBranchCreated({ onBranchCreated: [command] }, mockContext);

        await vi.waitFor(() => {
          expect((service as any).killTimers.size).toBe(0);
          expect((service as any).activeProcesses.size).toBe(0);
        });
      } finally {
        service.cleanup();
      }
    });
  });
});
