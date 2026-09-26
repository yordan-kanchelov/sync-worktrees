import { spawn } from "child_process";

export interface ClipboardResult {
  success: boolean;
  /** The command that took the text, on success. */
  tool?: string;
  error?: string;
}

interface ClipboardCommand {
  command: string;
  args: string[];
}

type SpawnFn = typeof spawn;

// A clipboard helper that neither exits nor fails inside this window is stuck
// (an X selection owner waiting on a display that never answers); the TUI must
// not wait on it any longer than this.
const CLIPBOARD_TIMEOUT_MS = 3000;

/**
 * The clipboard commands to try, in order, for this platform and session.
 * macOS always has `pbcopy`. On Linux the Wayland tool goes first when a
 * Wayland session is running, then the two X11 ones; a tool that is not
 * installed is skipped at spawn time, so the order is a preference, not a probe.
 */
export function clipboardCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform !== "linux") return [];
  const x11: ClipboardCommand[] = [
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
  const wayland: ClipboardCommand = { command: "wl-copy", args: [] };
  if (env.WAYLAND_DISPLAY) return [wayland, ...x11];
  // No Wayland session: wl-copy has nothing to talk to, and without a DISPLAY
  // neither X11 tool does either. Try them anyway -- an SSH session with X
  // forwarding sets DISPLAY late -- but a headless host ends with the message
  // below rather than a hang, because each attempt is bounded.
  return x11;
}

function runClipboardCommand(
  spawnFn: SpawnFn,
  { command, args }: ClipboardCommand,
  text: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (err) {
      resolve(`${command}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      finish(`${command} did not finish within ${CLIPBOARD_TIMEOUT_MS / 1000}s`);
      child.kill();
    }, CLIPBOARD_TIMEOUT_MS);
    function finish(error: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ENOENT" ? "ENOENT" : `${command}: ${err.message}`);
    });
    // "exit", not "close": xclip and wl-copy fork a child that keeps serving
    // the selection, and that child holds the stderr pipe open for as long as
    // it owns the clipboard, so "close" would not arrive until the user copied
    // something else. The stream is let go here for the same reason.
    child.on("exit", (code, signal) => {
      child.stderr?.destroy();
      if (code === 0) finish(null);
      else {
        const status = signal !== null ? `was killed by ${signal}` : `exited with code ${code}`;
        finish(`${command} ${status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }
    });
    // A tool that failed to start closes stdin under us; the error handler
    // above reports that, so the write's own EPIPE is not a second failure.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(text);
  });
}

/**
 * Put `text` on the system clipboard with the first clipboard command that is
 * installed and works. Never throws: with no tool at all the result says which
 * ones it looked for, so the caller can tell the user what to install.
 */
export async function copyToClipboard(
  text: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; spawn?: SpawnFn } = {},
): Promise<ClipboardResult> {
  const commands = clipboardCommands(options.platform, options.env);
  if (commands.length === 0) {
    return {
      success: false,
      error: `Copying to the clipboard is not supported on ${options.platform ?? process.platform}`,
    };
  }
  const spawnFn = options.spawn ?? spawn;
  const failures: string[] = [];
  for (const candidate of commands) {
    const error = await runClipboardCommand(spawnFn, candidate, text);
    if (error === null) return { success: true, tool: candidate.command };
    if (error !== "ENOENT") failures.push(error);
  }
  if (failures.length > 0) return { success: false, error: failures.join("; ") };
  return {
    success: false,
    error: `No clipboard tool found; install one of: ${commands.map((c) => c.command).join(", ")}`,
  };
}
