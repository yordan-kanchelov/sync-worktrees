import { execFile } from "child_process";
import { promisify } from "util";

import { confirm } from "@inquirer/prompts";

const execFileAsync = promisify(execFile);

const MCP_SERVER_NAME = "sync-worktrees";

const MCP_SERVER_COMMAND = [MCP_SERVER_NAME, "--", "npx", "-y", "-p", "sync-worktrees", "sync-worktrees-mcp"];

interface McpClient {
  tool: string;
  label: string;
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
    const code = (error as { code?: string | number }).code;
    if (code === "ENOENT") {
      return "absent";
    }
    if (code === 1) {
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      if (isMissingServerOutput(output)) {
        return "unregistered";
      }
    }
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

export async function maybeRegisterMcpClients(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

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
  } catch {}
}
