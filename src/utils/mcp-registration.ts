import { execFile } from "child_process";
import { promisify } from "util";

import { confirm } from "@inquirer/prompts";

const execFileAsync = promisify(execFile);

const MCP_SERVER_NAME = "sync-worktrees";

// Auto-detect mode only: the server locates the bare repo from its CWD, so one
// entry works across every repo. Deliberately no SYNC_WORKTREES_CONFIG binding.
const MCP_ADD_ARGS = ["mcp", "add", MCP_SERVER_NAME, "--", "npx", "-y", "-p", "sync-worktrees", "sync-worktrees-mcp"];

interface McpClient {
  tool: string;
  label: string;
}

const MCP_CLIENTS: McpClient[] = [
  { tool: "claude", label: "Claude Code" },
  { tool: "codex", label: "Codex" },
];

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

function manualHint(tool: string): string {
  return `   ${tool} mcp add ${MCP_SERVER_NAME} -- npx -y -p sync-worktrees sync-worktrees-mcp`;
}

async function registerClient(tool: string, label: string): Promise<void> {
  try {
    await execFileAsync(tool, MCP_ADD_ARGS, { timeout: 60_000 });
    console.log(`✅ Registered the sync-worktrees MCP server with ${label} (auto-detect mode).`);
  } catch {
    console.warn(`⚠️  Couldn't register automatically with ${label}. Run this yourself:`);
    console.warn(manualHint(tool));
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
    for (const { tool, label } of MCP_CLIENTS) {
      const status = await probeClient(tool);
      if (status !== "unregistered") {
        continue;
      }

      const proceed = await confirm({
        message: `${label} detected. Register the sync-worktrees MCP server so it can manage your worktrees?`,
        default: true,
      });
      if (proceed) {
        await registerClient(tool, label);
      }
    }
  } catch {
    // ponytail: user aborted the prompt or a client misbehaved — skip MCP setup.
  }
}
