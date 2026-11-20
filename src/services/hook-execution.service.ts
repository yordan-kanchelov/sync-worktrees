import { spawn } from "child_process";

import { DEFAULT_CONFIG, HOOK_CONSTANTS } from "../constants";
import { stripGitRepositorySelection } from "../utils/git-env";
import { shellEscape } from "../utils/shell-escape";

import type { HookContext, HooksConfig } from "../types";
import type { ChildProcess } from "child_process";

const HOOK_TERMINATION_GRACE_MS = 250;

export interface HookExecutionCallbacks {
  onStdout?: (line: string, command: string) => void;
  onStderr?: (line: string, command: string) => void;
  onError?: (command: string, error: Error) => void;
  onComplete?: (command: string, exitCode: number | null) => void;
  onSkipped?: (commands: string[]) => void;
}

export class HookExecutionService {
  private activeProcesses = new Map<ChildProcess, string>();
  private killTimers = new Set<ReturnType<typeof setTimeout>>();
  private timeoutTimers = new Set<ReturnType<typeof setTimeout>>();
  private generation = 0;

  executeOnBranchCreated(
    hooks: HooksConfig | undefined,
    context: HookContext,
    callbacks: HookExecutionCallbacks = {},
  ): void {
    if (!hooks?.onBranchCreated?.length) {
      return;
    }

    const env = this.buildEnvironment(context);
    const timeoutMs = hooks.timeoutMs ?? DEFAULT_CONFIG.HOOK_TIMEOUT_MS;

    const commands = hooks.onBranchCreated.map((command) => this.resolveCommandPlaceholders(command, context));
    void this.runSequentially(commands, env, callbacks, timeoutMs, context.worktreePath);
  }

  private async runSequentially(
    commands: string[],
    env: NodeJS.ProcessEnv,
    callbacks: HookExecutionCallbacks,
    timeoutMs: number,
    cwd: string,
  ): Promise<void> {
    const generation = this.generation;
    for (const [index, command] of commands.entries()) {
      if (generation !== this.generation) return;
      const ok = await this.runCommand(command, env, callbacks, timeoutMs, cwd);
      if (!ok) {
        const rest = commands.slice(index + 1);
        if (rest.length > 0 && generation === this.generation) callbacks.onSkipped?.(rest);
        return;
      }
    }
  }

  public getActiveCount(): number {
    return this.activeProcesses.size;
  }

  public async cleanup(): Promise<string[]> {
    this.generation++;
    for (const timer of this.timeoutTimers) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();

    for (const timer of this.killTimers) {
      clearTimeout(timer);
    }
    this.killTimers.clear();

    const signalled: string[] = [];
    const pending: ChildProcess[] = [];
    for (const [child, command] of this.activeProcesses) {
      if (!this.terminateChild(child, "SIGTERM")) continue;
      signalled.push(command);
      pending.push(child);
    }
    this.activeProcesses.clear();
    if (pending.length === 0) return signalled;

    for (const child of await this.waitForExit(pending, HOOK_TERMINATION_GRACE_MS)) {
      this.terminateChild(child, "SIGKILL");
    }
    return signalled;
  }

  private async waitForExit(children: ChildProcess[], graceMs: number): Promise<ChildProcess[]> {
    const alive = new Set(children);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      expiry = setTimeout(resolve, graceMs);
    });
    const settled = children.map(
      (child) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            alive.delete(child);
            resolve();
          };
          child.once("close", done);
          child.once("error", done);
        }),
    );

    await Promise.race([Promise.all(settled), expired]);
    clearTimeout(expiry);
    return [...alive];
  }

  private buildEnvironment(context: HookContext): NodeJS.ProcessEnv {
    return {
      ...stripGitRepositorySelection(process.env),
      [HOOK_CONSTANTS.ENV_VARS.BRANCH_NAME]: context.branchName,
      [HOOK_CONSTANTS.ENV_VARS.WORKTREE_PATH]: context.worktreePath,
      [HOOK_CONSTANTS.ENV_VARS.REPO_NAME]: context.repoName,
      [HOOK_CONSTANTS.ENV_VARS.BASE_BRANCH]: context.baseBranch,
      [HOOK_CONSTANTS.ENV_VARS.REPO_URL]: context.repoUrl,
    };
  }

  private resolveCommandPlaceholders(command: string, context: HookContext): string {
    const values: Record<string, string> = {
      [HOOK_CONSTANTS.PLACEHOLDERS.BRANCH_NAME]: context.branchName,
      [HOOK_CONSTANTS.PLACEHOLDERS.WORKTREE_PATH]: context.worktreePath,
      [HOOK_CONSTANTS.PLACEHOLDERS.REPO_NAME]: context.repoName,
      [HOOK_CONSTANTS.PLACEHOLDERS.BASE_BRANCH]: context.baseBranch,
      [HOOK_CONSTANTS.PLACEHOLDERS.REPO_URL]: context.repoUrl,
    };
    return command.replace(/\{[A-Z_]+\}/g, (match) =>
      Object.hasOwn(values, match) ? shellEscape(values[match]) : match,
    );
  }

  private runCommand(
    command: string,
    env: NodeJS.ProcessEnv,
    callbacks: HookExecutionCallbacks,
    timeoutMs: number,
    cwd?: string,
  ): Promise<boolean> {
    let settle!: (ok: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd,
    });

    this.activeProcesses.set(child, command);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      const scheduledTimer = setTimeout(() => {
        timedOut = true;
        this.timeoutTimers.delete(scheduledTimer);
        this.terminateChild(child, "SIGTERM");
        const scheduledKillTimer = setTimeout(() => {
          this.terminateChild(child, "SIGKILL");
          this.killTimers.delete(scheduledKillTimer);
        }, 5000);
        killTimer = scheduledKillTimer;
        this.killTimers.add(killTimer);
        callbacks.onError?.(command, new Error(`Hook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer = scheduledTimer;
      this.timeoutTimers.add(timer);
    }

    const clearHookTimers = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timeoutTimers.delete(timer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        this.killTimers.delete(killTimer);
      }
    };

    this.forwardLines(child.stdout, command, callbacks.onStdout);
    this.forwardLines(child.stderr, command, callbacks.onStderr);

    child.on("error", (error) => {
      clearHookTimers();
      this.activeProcesses.delete(child);
      callbacks.onError?.(command, error);
      settle(false);
    });

    child.on("close", (code) => {
      clearHookTimers();
      this.activeProcesses.delete(child);
      if (timedOut) {
        settle(false);
        return;
      }
      callbacks.onComplete?.(command, code);
      settle(code === 0);
    });

    return result;
  }

  private forwardLines(
    stream: NodeJS.ReadableStream | null,
    command: string,
    emit: ((line: string, command: string) => void) | undefined,
  ): void {
    if (!stream) return;
    stream.setEncoding("utf8");
    let pending = "";
    const send = (line: string): void => {
      const trimmed = line.trimEnd();
      if (trimmed.trim()) emit?.(trimmed, command);
    };
    stream.on("data", (chunk: string) => {
      const parts = (pending + chunk).split("\n");
      pending = parts.pop() ?? "";
      parts.forEach(send);
    });
    stream.on("end", () => {
      send(pending);
      pending = "";
    });
  }

  private terminateChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
        return true;
      }
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
