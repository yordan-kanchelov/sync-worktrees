import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigValidationError } from "../errors";

const mocks = vi.hoisted(() => ({
  buildRepositories: vi.fn(),
  constructService: vi.fn(),
  hasInteractiveTerminal: vi.fn(() => true),
}));

vi.mock("../utils/terminal", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasInteractiveTerminal: mocks.hasInteractiveTerminal,
}));

vi.mock("../services/config-loader.service", () => ({
  ConfigLoaderService: vi.fn(function () {
    return { buildRepositories: mocks.buildRepositories };
  }),
}));

vi.mock("../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function (config: unknown) {
    mocks.constructService(config);
    return { getRecordedSkips: vi.fn(() => []), initialize: vi.fn(), sync: vi.fn(async () => ({ started: true })) };
  }),
}));

vi.mock("../services/InteractiveUIService", () => ({
  InteractiveUIService: vi.fn(function () {
    return {
      addLog: vi.fn(),
      calculateAndUpdateDiskSpace: vi.fn(),
      destroy: vi.fn(),
      setRepositoryFilter: vi.fn(),
      setupCronJobs: vi.fn(),
      triggerInitialSync: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../utils/signal-handlers", () => ({
  setupSignalHandlers: vi.fn(() => ({ register: vi.fn(), dispose: vi.fn() })),
}));

import { main, reportUnhandledError } from "../index";
import { InteractiveUIService } from "../services/InteractiveUIService";

const originalArgv = process.argv;

class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * `runSync` used to wrap the whole run in one catch labelled "Error loading
 * config file", so anything that escaped `runMultipleRepositories` — a service
 * constructor rejecting a repository name, a render that will not mount — sent
 * the person to edit a file that had already loaded without complaint.
 */
describe("sync-worktrees run error reporting", () => {
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    // Some tests make the constructor throw; clearAllMocks keeps that.
    mocks.constructService.mockReset();
    mocks.hasInteractiveTerminal.mockReturnValue(true);
    process.argv = ["node", "sync-worktrees", "--config", "/test/sync-worktrees.config.js"];
    errors = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ProcessExit(typeof code === "number" ? code : undefined);
    });
    mocks.buildRepositories.mockResolvedValue({
      configFile: { repositories: [] },
      repositories: [
        {
          name: "app",
          repoUrl: "https://invalid.example/app.git",
          worktreeDir: "/test/worktrees",
          cronSchedule: "0 * * * *",
          runOnce: false,
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
  });

  async function runAndCaptureExit(): Promise<number | undefined> {
    return main().then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof ProcessExit) return error.code;
        throw error;
      },
    );
  }

  it("does not blame the config file for a failure that happens after it loaded", async () => {
    mocks.constructService.mockImplementation(() => {
      throw new ConfigValidationError("removal audit log name", "'con' is a reserved name on Windows");
    });

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).toContain("reserved name on Windows");
    expect(stderr).toContain("Error running sync");
    expect(stderr).not.toContain("Error loading config file");
    // A typed failure is something the person can act on, and its message says
    // all of it; dumping frames of this tool's internals over it says nothing.
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  // The counterpart: relabelling everything would be just as wrong as the
  // single label was. A config that will not load still says so.
  it("still blames the config file when the config is what failed", async () => {
    mocks.buildRepositories.mockRejectedValue(new Error("Failed to load config file: Unexpected token ']'"));

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).toContain("Error loading config file: Unexpected token ']'");
    // The loader's own prefix is not repeated after this line's label.
    expect(stderr).not.toContain("Failed to load config file");
    expect(stderr).not.toContain("Error running sync");
  });

  // systemd, docker, CI, `< /dev/null`: Ink printed "Raw mode is not
  // supported" with a stack and the process exited 0 having synced nothing.
  it("refuses to start the dashboard without a terminal and points at --run-once", async () => {
    mocks.hasInteractiveTerminal.mockReturnValue(false);

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).toContain("needs a terminal");
    expect(stderr).toContain("--run-once");
    expect(mocks.constructService).not.toHaveBeenCalled();
  });

  it("runs a one-shot sync without a terminal", async () => {
    mocks.hasInteractiveTerminal.mockReturnValue(false);
    process.argv = ["node", "sync-worktrees", "--config", "/test/sync-worktrees.config.js", "--runOnce"];

    expect(await runAndCaptureExit()).toBeUndefined();

    expect(errors.join("\n")).not.toContain("needs a terminal");
    expect(mocks.constructService).toHaveBeenCalledTimes(1);
  });

  it("--debug turns debug on for every repository, over the config", async () => {
    process.argv = ["node", "sync-worktrees", "--config", "/test/sync-worktrees.config.js", "--runOnce", "--debug"];

    expect(await runAndCaptureExit()).toBeUndefined();

    // The loader applies it (config-loader.service.test covers that), so every
    // load of the config gets it, not only the first.
    expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/sync-worktrees.config.js", { debug: true });
  });

  // The dashboard loads the config again when `r` is pressed; a --debug that
  // only reached the startup load quietly switched itself off on reload.
  it("--debug is handed to the dashboard so its reload applies it too", async () => {
    process.argv = ["node", "sync-worktrees", "--config", "/test/sync-worktrees.config.js", "--debug"];

    const code = await runAndCaptureExit();
    expect(errors).toEqual([]);
    expect(code).toBeUndefined();

    expect(vi.mocked(InteractiveUIService)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(InteractiveUIService).mock.calls[0][5]).toEqual({ debug: true });
  });

  it("does not force debug on the dashboard without --debug", async () => {
    expect(await runAndCaptureExit()).toBeUndefined();

    expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/sync-worktrees.config.js", { debug: false });
    expect(vi.mocked(InteractiveUIService).mock.calls[0][5]).toEqual({ debug: false });
  });

  // A bug in this tool has nothing useful to say in one line, so it keeps its
  // stack — scrubbed, because a git failure quotes the remote it was given.
  it("keeps the stack of an unexpected run failure", async () => {
    mocks.constructService.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'worktreeDir')");
    });

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).toContain("Error running sync");
    expect(stderr).toMatch(/\n\s+at /);
  });

  // git quotes the remote it was handed, so a repository cloned from a URL with
  // an access token in it puts that token in the failure text — and the stack
  // begins with that same text. Both lines this phase prints are new output, so
  // both are pinned: dropping either scrub is otherwise invisible.
  it("scrubs a credential-bearing URL from the run-phase line and its stack", async () => {
    mocks.constructService.mockImplementation(() => {
      throw new TypeError("unable to access 'https://ci-bot:s3cr3t-token@example.com/org/repo.git/'");
    });

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).not.toContain("s3cr3t-token");
    expect(stderr).not.toContain("ci-bot");
    // Redacted, not swallowed: the host and the path still identify the remote,
    // and the stack is still there.
    expect(stderr).toContain("https://***@example.com/org/repo.git");
    expect(stderr).toMatch(/\n\s+at /);
  });

  // The load-phase line printed `(error as Error).message` with no scrubbing at
  // all until this change, so a config whose failure quoted a credential-bearing
  // remote printed the token verbatim. Same for `list`, below.
  it("scrubs a credential-bearing URL from a load failure", async () => {
    mocks.buildRepositories.mockRejectedValue(
      new Error("Failed to load config file: cannot reach https://ci-bot:s3cr3t-token@example.com/org/repo.git"),
    );

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).toContain("Error loading config file");
    expect(stderr).not.toContain("s3cr3t-token");
    expect(stderr).toContain("https://***@example.com/org/repo.git");
  });

  it("scrubs a credential-bearing URL from a load failure reported by 'list'", async () => {
    process.argv = ["node", "sync-worktrees", "list", "--config", "/test/sync-worktrees.config.js"];
    mocks.buildRepositories.mockRejectedValue(
      new Error("Failed to load config file: cannot reach https://ci-bot:s3cr3t-token@example.com/org/repo.git"),
    );

    expect(await runAndCaptureExit()).toBe(1);

    const stderr = errors.join("\n");
    expect(stderr).toContain("Error loading config file");
    expect(stderr).not.toContain("s3cr3t-token");
    expect(stderr).toContain("https://***@example.com/org/repo.git");
  });
  // `--filter` narrows a sync the way it narrows `list`, and a filter that
  // selects nothing is answered the same way: a typo, not a clean no-op run.
  it("passes --filter to the loader and fails when it matches nothing", async () => {
    process.argv.push("--filter", "nope");
    mocks.buildRepositories.mockResolvedValue({ configFile: { repositories: [] }, repositories: [] });

    expect(await runAndCaptureExit()).toBe(1);

    expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/sync-worktrees.config.js", {
      debug: false,
      filter: "nope",
    });
    expect(errors.join("\n")).toContain("No repositories match filter: nope");
    expect(mocks.constructService).not.toHaveBeenCalled();
  });

  it("syncs only what --filter matched", async () => {
    process.argv.push("-f", "app");

    expect(await runAndCaptureExit()).toBeUndefined();

    expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/sync-worktrees.config.js", {
      debug: false,
      filter: "app",
    });
    expect(mocks.constructService).toHaveBeenCalledTimes(1);
  });

  it("drops the 'Using config' line under --quiet", async () => {
    process.argv.push("--quiet");

    expect(await runAndCaptureExit()).toBeUndefined();

    const stdout = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
    expect(stdout).not.toContain("Using config");
  });

  it("prints the 'Using config' line without --quiet", async () => {
    expect(await runAndCaptureExit()).toBeUndefined();

    const stdout = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
    expect(stdout).toContain("Using config");
  });
});

// bin/sync-worktrees.js is what runs in normal use, and its handler printed the
// raw value: util.inspect of a simple-git failure includes `task.commands`,
// remote URL and any token in it.
describe("reportUnhandledError (the bin shim's last-resort handler)", () => {
  it("scrubs a credential-bearing URL from the message, stack and inspected properties", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    const error = Object.assign(new Error("fatal: https://ci-bot:s3cr3t-token@example.com/org/repo.git"), {
      task: { commands: ["fetch", "https://ci-bot:s3cr3t-token@example.com/org/repo.git"] },
    });

    reportUnhandledError(error);
    vi.restoreAllMocks();

    const output = lines.join("\n");
    expect(output).toContain("❌ Unhandled error:");
    expect(output).toContain("https://***@example.com/org/repo.git");
    expect(output).toContain("commands");
    expect(output).not.toContain("s3cr3t-token");
  });
});
