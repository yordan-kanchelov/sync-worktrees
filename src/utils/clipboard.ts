import { spawn } from "child_process";

export interface ClipboardResult {
  success: boolean;
  tool?: string;
  error?: string;
}

interface ClipboardCommand {
  command: string;
  args: string[];
}

type SpawnFn = typeof spawn;

const CLIPBOARD_TIMEOUT_MS = 3000;

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
    child.on("exit", (code, signal) => {
      child.stderr?.destroy();
      if (code === 0) finish(null);
      else {
        const status = signal !== null ? `was killed by ${signal}` : `exited with code ${code}`;
        finish(`${command} ${status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(text);
  });
}

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
