import { spawn } from "child_process";

import { DEFAULT_CONFIG, HOOK_CONSTANTS } from "../constants";

import type { HookContext, HooksConfig } from "../types";
import type { ChildProcess } from "child_process";

export interface HookExecutionCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onError?: (command: string, error: Error) => void;
  onComplete?: (command: string, exitCode: number | null) => void;
}

export class HookExecutionService {
  private activeProcesses = new Set<ChildProcess>();
  private killTimers = new Set<ReturnType<typeof setTimeout>>();
  private timeoutMs: number = DEFAULT_CONFIG.HOOK_TIMEOUT_MS;

  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  executeOnBranchCreated(
    hooks: HooksConfig | undefined,
    context: HookContext,
    callbacks: HookExecutionCallbacks = {},
  ): void {
    if (!hooks?.onBranchCreated?.length) {
      return;
    }

    const env = this.buildEnvironment(context);

    for (const command of hooks.onBranchCreated) {
      const resolvedCommand = this.resolveCommandPlaceholders(command, context);
      this.executeCommandInBackground(resolvedCommand, env, callbacks, context.worktreePath);
    }
  }

  public cleanup(): void {
    for (const timer of this.killTimers) {
      clearTimeout(timer);
    }
    this.killTimers.clear();

    for (const child of this.activeProcesses) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
        this.killTimers.delete(killTimer);
      }, 5000);
      this.killTimers.add(killTimer);
    }
    this.activeProcesses.clear();
  }

  private shellEscape(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }

  private buildEnvironment(context: HookContext): NodeJS.ProcessEnv {
    return {
      ...process.env,
      [HOOK_CONSTANTS.ENV_VARS.BRANCH_NAME]: context.branchName,
      [HOOK_CONSTANTS.ENV_VARS.WORKTREE_PATH]: context.worktreePath,
      [HOOK_CONSTANTS.ENV_VARS.REPO_NAME]: context.repoName,
      [HOOK_CONSTANTS.ENV_VARS.BASE_BRANCH]: context.baseBranch,
      [HOOK_CONSTANTS.ENV_VARS.REPO_URL]: context.repoUrl,
    };
  }

  private resolveCommandPlaceholders(command: string, context: HookContext): string {
    return command
      .replaceAll(HOOK_CONSTANTS.PLACEHOLDERS.BRANCH_NAME, this.shellEscape(context.branchName))
      .replaceAll(HOOK_CONSTANTS.PLACEHOLDERS.WORKTREE_PATH, this.shellEscape(context.worktreePath))
      .replaceAll(HOOK_CONSTANTS.PLACEHOLDERS.REPO_NAME, this.shellEscape(context.repoName))
      .replaceAll(HOOK_CONSTANTS.PLACEHOLDERS.BASE_BRANCH, this.shellEscape(context.baseBranch))
      .replaceAll(HOOK_CONSTANTS.PLACEHOLDERS.REPO_URL, this.shellEscape(context.repoUrl));
  }

  private executeCommandInBackground(
    command: string,
    env: NodeJS.ProcessEnv,
    callbacks: HookExecutionCallbacks,
    cwd?: string,
  ): void {
    const child = spawn(command, {
      shell: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd,
    });

    this.activeProcesses.add(child);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      this.activeProcesses.delete(child);
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
        this.killTimers.delete(killTimer);
      }, 5000);
      this.killTimers.add(killTimer);
      callbacks.onError?.(command, new Error(`Hook timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          callbacks.onStdout?.(output);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          callbacks.onStderr?.(output);
        }
      });
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      this.activeProcesses.delete(child);
      callbacks.onError?.(command, error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      this.activeProcesses.delete(child);
      callbacks.onComplete?.(command, code);
    });
  }
}
