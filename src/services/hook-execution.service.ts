import { spawn } from "child_process";

import { DEFAULT_CONFIG, HOOK_CONSTANTS } from "../constants";
import { stripGitRepositorySelection } from "../utils/git-env";
import { shellEscape } from "../utils/shell-escape";

import type { HookContext, HooksConfig } from "../types";
import type { ChildProcess } from "child_process";

// How long a quit waits after SIGTERM before it stops being polite. A trapped
// SIGTERM is the whole reason this service signals rather than just exiting,
// and it only means something if the trap gets to run: the quit closes the
// pipes the hook holds as stdout and stderr the moment this resolves, so
// without a wait the trap is SIGPIPEd at its first line of output — measured,
// a trap that echoes dies part-way while the same trap writing only to files
// completes. Small, because quit latency is what the user feels, and paid only
// when a hook is actually running and does not go quietly.
const HOOK_TERMINATION_GRACE_MS = 250;

export interface HookExecutionCallbacks {
  /** One whole output line, and the command that wrote it. */
  onStdout?: (line: string, command: string) => void;
  onStderr?: (line: string, command: string) => void;
  onError?: (command: string, error: Error) => void;
  onComplete?: (command: string, exitCode: number | null) => void;
  /** Commands not run because an earlier one failed or timed out. */
  onSkipped?: (commands: string[]) => void;
}

export class HookExecutionService {
  private activeProcesses = new Map<ChildProcess, string>();
  private killTimers = new Set<ReturnType<typeof setTimeout>>();
  private timeoutTimers = new Set<ReturnType<typeof setTimeout>>();
  // Bumped by cleanup() so a running chain does not start its next command.
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
    // Per call, not per service: one HookExecutionService is shared by every
    // repository the interface holds, so a repository's `hooks.timeoutMs` has
    // to travel with its commands rather than being stored on the instance.
    // `??`, not `||`: 0 is the configured "no timeout", not an absent value.
    const timeoutMs = hooks.timeoutMs ?? DEFAULT_CONFIG.HOOK_TIMEOUT_MS;

    const commands = hooks.onBranchCreated.map((command) => this.resolveCommandPlaceholders(command, context));
    void this.runSequentially(commands, env, callbacks, timeoutMs, context.worktreePath);
  }

  // In array order, each after the previous one exits 0; the first failure
  // stops the rest, so `install` then `build` never race.
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

  /** How many hook commands are still running. */
  public getActiveCount(): number {
    return this.activeProcesses.size;
  }

  /**
   * Terminates every hook still running and returns the commands it actually
   * signalled, so a quit can name what it ended. Hooks deliberately do not
   * outlive this process: stdout and stderr are pipes into it, so a survivor
   * would take an uncatchable SIGPIPE at its next write rather than the SIGTERM
   * it can trap. Resolves once they are gone, or once they have been SIGKILLed.
   */
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
      // Named only once the signal has been delivered. A hook that exited
      // between its last write and this loop is still in the map — its close
      // event is queued behind us — and killing its group answers ESRCH, so
      // listing it would be the quit claiming a kill that never happened.
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
    // Waits for each child's streams to close and answers with the ones that
    // did not manage it inside the grace: the hooks a quit has to stop asking.
    //
    // Close, rather than the child's own exit status. The shell the service
    // spawned dies on the first SIGTERM whatever its children do, so a hook
    // that ignores the signal leaves an exited direct child and a grandchild
    // still holding the pipes; reading the shell's exitCode would call that one
    // dead and orphan the work. The pipes stay open exactly as long as
    // something in the group is still there to write down them.
    const alive = new Set(children);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      expiry = setTimeout(resolve, graceMs);
    });
    // Safe to attach after the signal rather than before: every child here is
    // still in activeProcesses, and the handler in runCommand
    // that removes it runs on this same close event, so neither can have been
    // delivered yet.
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

  // Hook commands run with the new worktree as their working directory, which
  // is the whole of what "runs in the worktree" promises them. An inherited
  // repository-selection variable outranks that directory for every git the
  // hook runs, so the promise only holds once those are gone (see
  // stripGitRepositorySelection). Nothing else about the hook's environment is
  // touched: an editor, a pager and a terminal prompt are all things a hook
  // command may legitimately want, unlike the git this tool runs itself.
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
    // One pass with a function replacer: no `$` patterns, no re-expansion.
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

    // 0 (and anything else non-positive) means no timer at all: the hook runs
    // for as long as it takes, which is what an install step on a large
    // repository needs and what leaves a wedged hook running until quit.
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

  // Decoded as UTF-8 by the stream (so a character split across writes
  // survives) and handed on one whole line at a time.
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
    // True only when the signal was delivered. The group kill raises ESRCH for
    // a child that has already exited, and that is the difference between a
    // hook this quit ended and one that ended on its own a moment earlier.
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
