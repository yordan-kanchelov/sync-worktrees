import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigValidationError } from "../errors";

const mocks = vi.hoisted(() => ({
  buildRepositories: vi.fn(),
  constructService: vi.fn(),
}));

vi.mock("../services/config-loader.service", () => ({
  ConfigLoaderService: vi.fn(function () {
    return { buildRepositories: mocks.buildRepositories };
  }),
}));

vi.mock("../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function (config: unknown) {
    mocks.constructService(config);
    return { getRecordedSkips: vi.fn(() => []), initialize: vi.fn(), sync: vi.fn() };
  }),
}));

vi.mock("../services/InteractiveUIService", () => ({
  InteractiveUIService: vi.fn(function () {
    return {
      addLog: vi.fn(),
      calculateAndUpdateDiskSpace: vi.fn(),
      destroy: vi.fn(),
      setupCronJobs: vi.fn(),
    };
  }),
}));

vi.mock("../utils/signal-handlers", () => ({
  setupSignalHandlers: vi.fn(() => ({ register: vi.fn(), dispose: vi.fn() })),
}));

import { main } from "../index";

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
    expect(stderr).toContain("Error loading config file");
    expect(stderr).toContain("Unexpected token ']'");
    expect(stderr).not.toContain("Error running sync");
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
});
