import * as path from "path";
import { spawn, spawnSync } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync } from "fs";
import { TERMINAL_CONSTANTS } from "../constants";
import { shellEscape } from "../utils/shell-escape";
import { copyToClipboard } from "../utils/clipboard";
import { PathResolutionService } from "./path-resolution.service";

const DEFAULT_EDITOR = "code";
// A launcher that exits non-zero inside this window never opened a window; one that exits
// later ran and was closed, which is the user's business and not a launch failure.
const LAUNCH_FAILURE_WINDOW_MS = 5000;
const TERMINAL_EDITOR_BASENAMES = new Set(["vi", "vim", "nvim", "nano", "pico", "micro", "helix", "hx", "kak"]);
const EMACS_BASENAMES = new Set(["emacs", "emacsclient"]);
const EMACS_TTY_FLAGS = new Set(["-nw", "--no-window-system", "-t", "--tty"]);
// `-g` is a GUI flag to vim and to nobody else on the list: measured here, `vim -g` and `vi -g`
// reach vim's own parser and answer "E25: GUI cannot be used", while nano and pico read `-g` as
// --showcursor, helix as --grammar and emacs as --geometry, and nvim has no `-g` at all. So the
// escape hatch is scoped to the family that defines it instead of being read off any argv.
const VIM_BASENAMES = new Set(["vi", "vim"]);
const VIM_GUI_FLAGS = new Set(["-g"]);
// Exec flags a user may already have written into the override or $TERMINAL, where appending a
// second one would make it an argument to the first. Derived from the table below so a new
// entry there is recognised here too.
const TERMINAL_EXEC_FLAGS = new Set<string>([
  TERMINAL_CONSTANTS.DEFAULT_EXEC_FLAG,
  ...Object.values(TERMINAL_CONSTANTS.EXEC_FLAG_OVERRIDES),
]);

/**
 * Heuristic, and deliberately failing open: an editor we do not recognise is treated as a GUI
 * editor, which is exactly today's behaviour, so nothing that works now starts being refused.
 * Unknown terminal editors are caught a moment later by the non-zero exit instead. A flag beats
 * the basename only for the family whose own parser defines that flag, and an explicit terminal
 * flag wins over a GUI one: `emacs -nw` is refused even with `-g` on the line, `vim -g` is not.
 */
function isTerminalEditor(command: string, args: string[]): boolean {
  const base = path.basename(command);
  // emacs draws a window unless told otherwise, so for that family the tty flags decide alone.
  // They cannot be read off any other editor's argv: `-t` is vim's "edit where tag is defined".
  if (EMACS_BASENAMES.has(base)) return args.some((arg) => EMACS_TTY_FLAGS.has(arg));
  if (!TERMINAL_EDITOR_BASENAMES.has(base)) return false;
  return !(VIM_BASENAMES.has(base) && args.some((arg) => VIM_GUI_FLAGS.has(arg)));
}

export interface LaunchResult {
  success: boolean;
  error?: string;
}

export interface TerminalLauncherHost {
  log(message: string, level: "info" | "warn" | "error"): void;
  /** The display name of the repository at `index`, or null when there is none. */
  getRepoName(index: number): string | null;
}

/**
 * The TUI's "open" actions: an editor on a worktree, or a terminal emulator
 * running a tmux session in it. Every launch is detached and unref'd, so the
 * outcome is reported through the host's log rather than awaited.
 */
export class TerminalLauncher {
  private readonly pathResolution = new PathResolutionService();

  constructor(private readonly host: TerminalLauncherHost) {}

  public openEditorInWorktree(worktreePath: string): LaunchResult {
    const editor = process.env.EDITOR || process.env.VISUAL || DEFAULT_EDITOR;
    // EDITOR may include flags (e.g. "code -w") and a quoted path may contain spaces;
    // spawn without a shell treats the whole string as the binary name, so split it as a
    // shell would.
    const parsed = this.parseCommandString(editor);
    if (!parsed) {
      // Only a set-but-blank EDITOR/VISUAL reaches here: unset and empty are falsy and already
      // fell through to the default above. Quietly editing with something else instead would
      // be the same silent substitution this method exists to stop.
      const message = "EDITOR/VISUAL is set to whitespace only; set it to an editor command";
      this.host.log(message, "error");
      return { success: false, error: message };
    }
    const { command, args: editorArgs } = parsed;

    if (isTerminalEditor(command, editorArgs)) {
      // Refuse rather than spawn: detached with stdio "ignore" there is no TTY, so the editor
      // reads EOF and exits within about two seconds having drawn nothing. Reporting that as
      // success is the defect. Terminal mode runs tmux in an emulator, which is where a terminal
      // editor can really run -- but only if an emulator resolves, so ask before sending anyone
      // there: on a headless host the probe finds none and that advice is a second dead end.
      const remedy = this.resolveTerminalLauncher("")
        ? "use Terminal mode, or set EDITOR/VISUAL to a GUI editor"
        : "no emulator is available for Terminal mode either, so set EDITOR/VISUAL to a GUI editor";
      const message = `'${editor}' is a terminal editor and has no TTY here; ${remedy}`;
      this.host.log(message, "error");
      return { success: false, error: message };
    }

    try {
      const child = spawn(command, [...editorArgs, worktreePath], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", (err) => {
        this.host.log(`Failed to open editor '${editor}': ${err.message}`, "error");
        this.host.log("Set EDITOR or VISUAL environment variable to your preferred editor", "warn");
      });

      this.reportLauncherExit(
        child,
        "Editor",
        editor,
        // Deliberately not a diagnosis: nothing here knows why the child stopped, and the same
        // exit arrives from a terminal editor, a GUI editor with no display, a bad flag and a
        // missing library alike. The error line above names the command and the status.
        "Check EDITOR/VISUAL and its flags: a terminal editor needs a TTY, a GUI editor needs a display",
      );
      child.unref();

      // Success here means "launched", not "still running": the spawn is detached so the
      // outcome is only knowable later, and reportLauncherExit logs it when it arrives.
      return { success: true };
    } catch (err) {
      // Not the missing-binary case: a command that does not exist makes spawn return a
      // child with no pid and emit "error" asynchronously, which the handler above logs.
      // Only a bad call reaches here, e.g. arguments spawn rejects outright.
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.host.log(`Failed to open editor '${editor}': ${errorMessage}`, "error");
      return { success: false, error: errorMessage };
    }
  }

  private reportLauncherExit(child: ChildProcess, kind: string, command: string, hint: string): void {
    // The child is detached and unref'd, so it cannot be awaited without holding the TUI
    // open. The exit event still fires while the TUI lives, which costs nothing and blocks
    // nothing; after quit the host's log is a no-op, so a late exit cannot reopen a closed
    // wizard.
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      if (Date.now() - startedAt >= LAUNCH_FAILURE_WINDOW_MS) return;
      // A child killed by a signal reports code null with the signal set, so a code-only guard
      // drops exactly the crash worth hearing about: measured here, a launcher that segfaults
      // or aborts arrives 3ms in with code null, and the wizard had already said success.
      const outcome =
        signal !== null
          ? `was killed by ${signal}`
          : code !== null && code !== 0
            ? `exited immediately with code ${code}`
            : null;
      if (outcome === null) return;
      this.host.log(`${kind} '${command}' ${outcome} — nothing was opened`, "error");
      this.host.log(hint, "warn");
    });
  }

  public openTerminalInWorktree(repoIndex: number, worktreePath: string, branchName: string): LaunchResult {
    const repoName = this.host.getRepoName(repoIndex);
    if (repoName === null) {
      const message = `Invalid repository index: ${repoIndex}`;
      this.host.log(message, "error");
      return { success: false, error: message };
    }
    const sanitizedBranch = this.pathResolution.sanitizeBranchName(branchName);
    const sessionName = `${repoName}-${sanitizedBranch}`;
    const tmuxCommand = `tmux new-session -A -s ${shellEscape(sessionName)} -c ${shellEscape(worktreePath)}`;

    const launcher = this.resolveTerminalLauncher(tmuxCommand);
    if (!launcher) {
      const message =
        "No terminal launcher found. Set SYNC_WORKTREES_TERMINAL or $TERMINAL to a terminal emulator command.";
      this.host.log(message, "error");
      return { success: false, error: message };
    }

    try {
      const child = spawn(launcher.command, launcher.args, {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", (err) => {
        this.host.log(`Failed to open terminal '${launcher.command}': ${err.message}`, "error");
        this.host.log("Set SYNC_WORKTREES_TERMINAL to your preferred terminal command", "warn");
      });

      this.reportLauncherExit(
        child,
        "Terminal",
        launcher.command,
        `Check ${TERMINAL_CONSTANTS.ENV_OVERRIDE}: the emulator has to accept a trailing 'sh -c <command>'`,
      );
      child.unref();

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.host.log(`Failed to open terminal '${launcher.command}': ${errorMessage}`, "error");
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Put a worktree path on the system clipboard (`pbcopy`, `wl-copy`, `xclip`
   * or `xsel`). A missing tool is an answer, not an exception: the result says
   * what was looked for, and the log gets the path so it is not lost.
   */
  public async copyToClipboard(text: string): Promise<LaunchResult> {
    const result = await copyToClipboard(text);
    if (result.success) return { success: true };
    const error = result.error ?? "Copy to clipboard failed";
    this.host.log(`${error}; the path was not copied: ${text}`, "warn");
    return { success: false, error };
  }

  private resolveTerminalLauncher(tmuxCommand: string): { command: string; args: string[] } | null {
    // The tmux command is wrapped in `sh -c` so emulators that exec their trailing argv as a
    // program name (`alacritty -e`, `kitty -e`) can run the composite command -- which means
    // every branch below needs an exec flag, and they all get it from terminalExecArgs.
    const override = this.parseCommandString(process.env[TERMINAL_CONSTANTS.ENV_OVERRIDE]);
    if (override) {
      return {
        command: override.command,
        args: [...this.terminalExecArgs(override.command, override.args), "sh", "-c", tmuxCommand],
      };
    }

    switch (process.platform) {
      case "darwin": {
        // Ghostty cannot be launched directly from the CLI on macOS; use `open -na` instead.
        const ghosttyPaths = ["/Applications/Ghostty.app", `${process.env.HOME}/Applications/Ghostty.app`];
        if (ghosttyPaths.some((p) => existsSync(p))) {
          return {
            command: "open",
            // The flag is Ghostty's, not `open`'s, so it comes from the same table as the rest.
            args: ["-na", "Ghostty.app", "--args", ...this.terminalExecArgs("ghostty", []), "sh", "-c", tmuxCommand],
          };
        }
        const escapedTmuxCommand = tmuxCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal" to do script "${escapedTmuxCommand}"`;
        return { command: "osascript", args: ["-e", script] };
      }
      case "linux": {
        const envTerminal = this.parseCommandString(process.env[TERMINAL_CONSTANTS.ENV_FALLBACK]);
        if (envTerminal) {
          const args = this.terminalExecArgs(envTerminal.command, envTerminal.args);
          return { command: envTerminal.command, args: [...args, "sh", "-c", tmuxCommand] };
        }
        for (const candidate of TERMINAL_CONSTANTS.LINUX_CANDIDATES) {
          if (this.commandExists(candidate)) {
            return { command: candidate, args: [...this.terminalExecArgs(candidate, []), "sh", "-c", tmuxCommand] };
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  private terminalExecArgs(command: string, args: string[]): string[] {
    // One lookup for every launcher path, so the override, the $TERMINAL fallback and the
    // candidate probe can no longer disagree about which flag an emulator wants. A user who
    // already wrote an exec flag keeps theirs: a second one would be an argument to the first.
    if (args.some((arg) => TERMINAL_EXEC_FLAGS.has(arg))) return args;
    const overrides: Readonly<Record<string, string | undefined>> = TERMINAL_CONSTANTS.EXEC_FLAG_OVERRIDES;
    return [...args, overrides[path.basename(command)] ?? TERMINAL_CONSTANTS.DEFAULT_EXEC_FLAG];
  }

  private parseCommandString(raw: string | undefined): { command: string; args: string[] } | null {
    if (!raw || raw.trim().length === 0) return null;
    // Split the way a shell would: a quoted path keeps its spaces instead of becoming
    // several broken argv entries. An unterminated quote closes at end of string so a
    // typo degrades to a best-effort argv rather than silently dropping the setting.
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    let started = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
        } else if (quote === '"' && ch === "\\" && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
          current += raw[++i];
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        started = true;
      } else if (ch === "\\" && i + 1 < raw.length) {
        current += raw[++i];
        started = true;
      } else if (/\s/.test(ch)) {
        if (started) parts.push(current);
        current = "";
        started = false;
      } else {
        current += ch;
        started = true;
      }
    }
    if (started) parts.push(current);
    if (parts.length === 0) return null;
    return { command: parts[0], args: parts.slice(1) };
  }

  private commandExists(command: string): boolean {
    try {
      const result = spawnSync("which", [command], { stdio: "ignore" });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
