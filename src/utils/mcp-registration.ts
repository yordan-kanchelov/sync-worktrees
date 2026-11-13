import { execFile } from "child_process";
import { promisify } from "util";

import { confirm } from "@inquirer/prompts";

const execFileAsync = promisify(execFile);

const MCP_SERVER_NAME = "sync-worktrees";

// The server auto-detects the bare repo and config from its CWD, so one
// user-level entry works across every repo and worktree.
const MCP_SERVER_COMMAND = [MCP_SERVER_NAME, "--", "npx", "-y", "-p", "sync-worktrees", "sync-worktrees-mcp"];

interface McpClient {
  tool: string;
  label: string;
  // Claude Code's default `local` scope is per directory, i.e. per worktree.
  addFlags: string[];
}

const MCP_CLIENTS: McpClient[] = [
  { tool: "claude", label: "Claude Code", addFlags: ["--scope", "user"] },
  { tool: "codex", label: "Codex", addFlags: [] },
];

function mcpAddArgs(client: McpClient): string[] {
  return ["mcp", "add", ...client.addFlags, ...MCP_SERVER_COMMAND];
}

type ClientStatus = "absent" | "registered" | "unregistered" | "unknown";

function isMissingServerOutput(output: string): boolean {
  return /(not found|not registered|does not exist|unknown server|no MCP server)/i.test(output);
}

async function probeClient(tool: string): Promise<ClientStatus> {
  try {
    await execFileAsync(tool, ["mcp", "get", MCP_SERVER_NAME], { timeout: 15_000 });
    return "registered";
  } catch (error) {
    // execFile sets `code` to the string spawn error (ENOENT) or the numeric exit code.
    const code = (error as { code?: string | number }).code;
    if (code === "ENOENT") {
      return "absent"; // CLI not installed
    }
    if (code === 1) {
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      if (isMissingServerOutput(output)) {
        return "unregistered";
      }
    }
    // Timeout, unexpected exit code, or an older CLI without `mcp get` — we don't
    // actually know it's missing, so don't offer to add it.
    return "unknown";
  }
}

function manualHint(client: McpClient): string {
  return `   ${client.tool} ${mcpAddArgs(client).join(" ")}`;
}

async function registerClient(client: McpClient): Promise<void> {
  const { tool, label } = client;
  try {
    await execFileAsync(tool, mcpAddArgs(client), { timeout: 60_000 });
    console.log(`✅ Registered the sync-worktrees MCP server with ${label} (auto-detect mode).`);
  } catch {
    console.warn(`⚠️  Couldn't register automatically with ${label}. Run this yourself:`);
    console.warn(manualHint(client));
  }
}

/**
 * Offers to register the sync-worktrees MCP server with any detected AI CLI
 * (Claude Code, Codex) that doesn't already have it. Best-effort: never throws,
 * so it can't fail an otherwise-successful `init`.
 */
export async function maybeRegisterMcpClients(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  // Best-effort: swallow anything (incl. an inquirer Ctrl-C rejection) so a
  // fully-written config never gets reported as a failed `init`.
  try {
    for (const client of MCP_CLIENTS) {
      const { tool, label } = client;
      const status = await probeClient(tool);
      if (status !== "unregistered") {
        continue;
      }

      const proceed = await confirm({
        message: `${label} detected. Register the sync-worktrees MCP server so it can manage your worktrees?`,
        default: true,
      });
      if (proceed) {
        await registerClient(client);
      }
    }
  } catch {
    // ponytail: user aborted the prompt or a client misbehaved — skip MCP setup.
  }
}
