import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InitConfigInput } from "../types";

const mocks = vi.hoisted(() => ({
  promptForInitConfig: vi.fn(),
  maybeRegisterMcpClients: vi.fn(),
}));

// Only the interactive surface is mocked: the generator and the config loader
// below are the real ones, because the point of this file is that `init` proves
// the file it just wrote actually loads.
vi.mock("../utils/interactive", () => ({ promptForInitConfig: mocks.promptForInitConfig }));
vi.mock("../utils/mcp-registration", () => ({ maybeRegisterMcpClients: mocks.maybeRegisterMcpClients }));

import { main } from "../index";

const originalArgv = process.argv;

class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe("sync-worktrees init round-trips the generated config", () => {
  let tempDir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-init-")));
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ProcessExit(typeof code === "number" ? code : undefined);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runInit(configPath: string): Promise<void> {
    process.argv = ["node", "sync-worktrees", "init", "--config", configPath];
    return main();
  }

  function answers(overrides: Partial<InitConfigInput["repositories"][number]> = {}): InitConfigInput {
    return {
      cronSchedule: "0 * * * *",
      repositories: [
        {
          repoUrl: "https://github.com/user/app.git",
          worktreeDir: path.join(tempDir, "app"),
          mode: "worktree",
          ...overrides,
        },
      ],
    };
  }

  it("reports success only after the generated file loads", async () => {
    mocks.promptForInitConfig.mockResolvedValue(answers());
    const configPath = path.join(tempDir, "sync-worktrees.config.js");

    await runInit(configPath);

    expect(logs.join("\n")).toContain("✅ Configuration saved to:");
    expect(mocks.maybeRegisterMcpClients).toHaveBeenCalledTimes(1);
    expect(mocks.promptForInitConfig).toHaveBeenCalledWith(tempDir);
  });

  // A config whose bareRepoDir sits on top of its worktreeDir is written
  // happily and then rejected by the loader on the next run. Before the
  // round-trip check the wizard printed "✅ Configuration saved", offered MCP
  // registration and exited 0.
  it("exits non-zero with the loader error when the generated config does not load", async () => {
    mocks.promptForInitConfig.mockResolvedValue(answers({ bareRepoDir: path.join(tempDir, "app") }));
    const configPath = path.join(tempDir, "sync-worktrees.config.js");

    await expect(runInit(configPath)).rejects.toMatchObject({ code: 1 });

    const stderr = errors.join("\n");
    expect(stderr).toContain("but it does not load");
    expect(stderr).toContain("must not overlap");
    expect(logs.join("\n")).not.toContain("✅ Configuration saved");
    expect(mocks.maybeRegisterMcpClients).not.toHaveBeenCalled();
  });

  it("leaves the written file in place when the round-trip fails", async () => {
    mocks.promptForInitConfig.mockResolvedValue(answers({ bareRepoDir: path.join(tempDir, "app") }));
    const configPath = path.join(tempDir, "sync-worktrees.config.js");

    await expect(runInit(configPath)).rejects.toMatchObject({ code: 1 });

    // The file holds the answers the user just typed, and is the only evidence
    // of what went wrong, so it is kept for them to inspect or fix.
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain("bareRepoDir");
    expect(errors.join("\n")).toContain("left in place");
  });

  // The check runs `buildRepositories`, the same entry point the sync run uses,
  // so it also catches what `loadConfigFile` alone would wave through: this
  // config parses and validates fine per-file and is only rejected by the
  // cross-repository path-collision pass.
  it("catches a failure that only the full repository build sees", async () => {
    mocks.promptForInitConfig.mockResolvedValue({
      cronSchedule: "0 * * * *",
      repositories: [
        { repoUrl: "https://github.com/user/app.git", worktreeDir: path.join(tempDir, "shared"), mode: "worktree" },
        { repoUrl: "https://github.com/user/lib.git", worktreeDir: path.join(tempDir, "shared"), mode: "worktree" },
      ],
    });
    const configPath = path.join(tempDir, "sync-worktrees.config.js");

    await expect(runInit(configPath)).rejects.toMatchObject({ code: 1 });

    expect(errors.join("\n")).toContain("resolve to the same worktreeDir");
    expect(logs.join("\n")).not.toContain("✅ Configuration saved");
  });
});
