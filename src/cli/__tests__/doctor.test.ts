import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigFileNotFoundError } from "../../errors";
import {
  checkDiskSpace,
  checkGit,
  checkGitLfs,
  checkNode,
  checkRemote,
  checkWritableDir,
  doctorExitCode,
  DOCTOR_DISK_FAIL_BYTES,
  DOCTOR_DISK_WARN_BYTES,
  DOCTOR_MIN_NODE_MAJOR,
  DOCTOR_REMOTE_TIMEOUT_MS,
  formatDoctorReport,
  runDoctor,
  runDoctorChecks,
  runGitNonInteractive,
} from "../doctor";

import type { AddressInfo } from "net";
import type { RepositoryConfig } from "../../types";
import type { DoctorCheck, DoctorDeps, GitRunResult } from "../doctor";

const ok = (stdout = ""): GitRunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const failed = (stderr: string, code = 128): GitRunResult => ({ code, stdout: "", stderr, timedOut: false });
const enoent = (): GitRunResult => ({
  code: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  spawnError: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
});

function repo(overrides: Partial<RepositoryConfig> = {}): RepositoryConfig {
  return {
    name: "app",
    repoUrl: "https://example.com/org/app.git",
    worktreeDir: "/work/app",
    bareRepoDir: "/work/.bare/app",
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  } as RepositoryConfig;
}

const isDir = { isDirectory: () => true };
const isFile = { isDirectory: () => false };

/**
 * A fake machine: every path under one of `existing` exists (as a directory
 * unless listed in `files`), everything is writable unless listed in
 * `readOnly`, and git answers from `git`.
 */
function deps(overrides: Partial<DoctorDeps> & { existing?: string[]; readOnly?: string[]; files?: string[] } = {}) {
  const existing = overrides.existing ?? ["/"];
  const readOnly = new Set(overrides.readOnly ?? []);
  const files = new Set(overrides.files ?? []);
  const base: DoctorDeps = {
    nodeVersion: "24.1.0",
    runGit: vi.fn(async (args: readonly string[]) => {
      if (args[0] === "--version") return ok("git version 2.43.0\n");
      if (args[0] === "lfs") return ok("git-lfs/3.4.1 (GitHub; linux amd64; go 1.22)\n");
      if (args[0] === "ls-remote") return ok("abc\trefs/heads/main\ndef\trefs/heads/dev\n");
      return failed("", 1);
    }),
    stat: vi.fn(async (target: string) => {
      if (files.has(target)) return isFile;
      if (existing.includes(target)) return isDir;
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
    }),
    accessWritable: vi.fn(async (target: string) => {
      if (readOnly.has(target)) throw Object.assign(new Error(`EACCES: ${target}`), { code: "EACCES" });
    }),
    freeBytes: vi.fn(async () => 50 * 1024 * 1024 * 1024),
    findConfig: vi.fn(async () => "/work/sync-worktrees.config.js"),
    loadRepositories: vi.fn(async () => [repo()]),
  };
  const { existing: _e, readOnly: _r, files: _f, ...rest } = overrides;
  return { ...base, ...rest };
}

function byCheck(checks: DoctorCheck[], id: string, repository: string | null = null): DoctorCheck | undefined {
  return checks.find((item) => item.check === id && item.repository === repository);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkNode", () => {
  it("keeps the same floor as bin/node-version.js and package.json engines", async () => {
    const modulePath = path.join(__dirname, "../../../bin/node-version.js");
    const { MIN_NODE_MAJOR } = (await import(pathToFileURL(modulePath).href)) as { MIN_NODE_MAJOR: number };
    expect(DOCTOR_MIN_NODE_MAJOR).toBe(MIN_NODE_MAJOR);
  });

  it("passes on a supported Node and names the engines range", () => {
    const result = checkNode("24.21.0");
    expect(result.status).toBe("pass");
    expect(result.message).toContain(">=24.0.0");
  });

  it("warns (not fails) below engines, like the start-up warning", () => {
    const result = checkNode("22.12.0");
    expect(result.status).toBe("warn");
    expect(result.hint).toContain("sync-worktrees@5");
  });
});

describe("checkGit", () => {
  it("fails with an install hint when git is not on PATH", async () => {
    const result = await checkGit({ runGit: async () => enoent() });
    expect(result.status).toBe("fail");
    expect(result.hint).toContain("Install git");
  });

  it("warns below 2.36 and names the worktree-listing fallback", async () => {
    const result = await checkGit({ runGit: async () => ok("git version 2.34.1\n") });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("2.34.1");
    expect(result.message).toContain("newline");
  });

  it.each(["git version 2.36.0", "git version 2.43.0", "git version 2.50.1 (Apple Git-155)"])(
    "passes on %s",
    async (out) => {
      expect((await checkGit({ runGit: async () => ok(out) })).status).toBe("pass");
    },
  );
});

describe("checkGitLfs", () => {
  it("passes when git-lfs is installed, without looking at any repository", async () => {
    const d = deps();
    const result = await checkGitLfs([repo()], d);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("git-lfs/3.4.1");
    expect(d.runGit).toHaveBeenCalledTimes(1);
  });

  it("warns when git-lfs is missing and a synced repository declares LFS files", async () => {
    const d = deps({
      existing: ["/", "/work/.bare/app"],
      runGit: vi.fn(async (args: readonly string[]) =>
        args[0] === "lfs" ? failed("git: 'lfs' is not a git command.", 1) : ok(".gitattributes\n"),
      ),
    });
    const result = await checkGitLfs([repo()], d);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("app uses LFS");
    expect(result.hint).toContain("skipLfs");
    expect(d.runGit).toHaveBeenCalledWith(expect.arrayContaining(["grep", "filter=lfs", "HEAD"]), {
      cwd: "/work/.bare/app",
      timeoutMs: expect.any(Number),
    });
  });

  it("passes when git-lfs is missing but nothing needs it; skipLfs and unsynced repositories are not probed", async () => {
    const runGit = vi.fn(async (args: readonly string[]) => (args[0] === "lfs" ? enoent() : ok(".gitattributes\n")));
    const d = deps({ existing: ["/", "/work/.bare/skip"], runGit });
    const result = await checkGitLfs(
      [repo({ name: "skip", bareRepoDir: "/work/.bare/skip", skipLfs: true }), repo({ name: "fresh" })],
      d,
    );
    expect(result.status).toBe("pass");
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it("looks in the checkout itself for a clone-mode repository", async () => {
    const runGit = vi.fn(async (args: readonly string[]) => (args[0] === "lfs" ? enoent() : ok(".gitattributes\n")));
    const d = deps({ existing: ["/", "/work/app"], runGit });
    const result = await checkGitLfs([repo({ mode: "clone", bareRepoDir: undefined })], d);
    expect(result.status).toBe("warn");
    expect(runGit).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ cwd: "/work/app" }));
  });
});

describe("checkRemote", () => {
  it("runs a heads-only ls-remote against the URL, after `--`, with the short timeout", async () => {
    const runGit = vi.fn(async () => ok("abc\trefs/heads/main\n"));
    const result = await checkRemote(repo(), { runGit });
    expect(runGit).toHaveBeenCalledWith(["ls-remote", "--heads", "--", "https://example.com/org/app.git"], {
      timeoutMs: DOCTOR_REMOTE_TIMEOUT_MS,
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 branch)");
  });

  it("fails an authentication error with the credential hint, and never prints the token", async () => {
    const url = "https://user:s3cret@example.com/org/app.git";
    const result = await checkRemote(repo({ repoUrl: url }), {
      runGit: async () =>
        failed(`fatal: could not read Username for 'https://user:s3cret@example.com': terminal prompts disabled\n`),
    });
    expect(result.status).toBe("fail");
    expect(result.hint).toContain("credential helper");
    expect(JSON.stringify(result)).not.toContain("s3cret");
    expect(result.message).toContain("https://***@example.com/org/app.git");
  });

  it("points at ssh-agent for a refused key, and at known_hosts for an unknown host", async () => {
    const key = await checkRemote(repo({ repoUrl: "git@example.com:org/app.git" }), {
      runGit: async () => failed("git@example.com: Permission denied (publickey).\nfatal: Could not read from remote"),
    });
    expect(key.hint).toContain("ssh-agent");
    const host = await checkRemote(repo({ repoUrl: "git@example.com:org/app.git" }), {
      runGit: async () => failed("Host key verification failed.\nfatal: Could not read from remote repository."),
    });
    expect(host.hint).toContain("known_hosts");
  });

  it("fails a remote that does not answer in time", async () => {
    const result = await checkRemote(repo(), {
      runGit: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("did not answer");
  });

  it("reports git's fatal line for any other failure", async () => {
    const result = await checkRemote(repo(), {
      runGit: async () => failed("fatal: repository 'https://example.com/org/app.git/' not found\n"),
    });
    expect(result.message).toContain("fatal: repository");
    expect(result.hint).toContain("repoUrl");
  });
});

describe("checkWritableDir", () => {
  it("passes an existing writable directory", async () => {
    const result = await checkWritableDir(
      "worktree-dir",
      "app",
      "worktreeDir",
      "/work/app",
      deps({ existing: ["/work/app"] }),
    );
    expect(result.status).toBe("pass");
    expect(result.message).toContain("is writable");
  });

  it("checks the nearest existing ancestor of a directory that does not exist yet", async () => {
    const d = deps({ existing: ["/", "/work"] });
    const result = await checkWritableDir("worktree-dir", "app", "worktreeDir", "/work/app/nested", d);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("will be created under /work");
    expect(d.accessWritable).toHaveBeenCalledWith("/work");
  });

  it("fails when that ancestor is read-only", async () => {
    const result = await checkWritableDir(
      "lock-dir",
      "app",
      "lock directory",
      "/ro/.sync-worktrees-locks",
      deps({ existing: ["/", "/ro"], readOnly: ["/ro"] }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("cannot be created: /ro is not writable");
    expect(result.hint).toContain("write access to /ro");
  });

  it("fails when a file sits where the directory should be", async () => {
    const result = await checkWritableDir(
      "worktree-dir",
      "app",
      "worktreeDir",
      "/work/app",
      deps({ existing: ["/", "/work"], files: ["/work/app"] }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a directory");
  });
});

describe("checkDiskSpace", () => {
  it.each([
    [DOCTOR_DISK_FAIL_BYTES - 1, "fail"],
    [DOCTOR_DISK_WARN_BYTES - 1, "warn"],
    [DOCTOR_DISK_WARN_BYTES, "pass"],
  ] as const)("%d free bytes is a %s", async (free, status) => {
    const [result] = await checkDiskSpace(repo(), deps({ freeBytes: async () => free }));
    expect(result.status).toBe(status);
  });

  it("measures each filesystem location once when both directories resolve to the same ancestor", async () => {
    const d = deps({ existing: ["/", "/work"] });
    const results = await checkDiskSpace(repo(), d);
    expect(results).toHaveLength(1);
    expect(d.freeBytes).toHaveBeenCalledWith("/work");
  });

  it("warns rather than fails when free space cannot be read", async () => {
    const [result] = await checkDiskSpace(
      repo(),
      deps({
        freeBytes: async () => {
          throw new Error("ENOSYS");
        },
      }),
    );
    expect(result.status).toBe("warn");
  });
});

describe("runDoctorChecks", () => {
  it("runs the machine checks, the config check and every repository's checks in order", async () => {
    const d = deps({ loadRepositories: vi.fn(async () => [repo(), repo({ name: "web", worktreeDir: "/work/web" })]) });
    const checks = await runDoctorChecks({}, d);
    expect(checks.slice(0, 4).map((item) => item.check)).toEqual(["node", "git", "git-lfs", "config"]);
    expect(byCheck(checks, "config")?.message).toContain("/work/sync-worktrees.config.js is valid (2 repositories)");
    for (const name of ["app", "web"]) {
      for (const id of ["remote", "worktree-dir", "bare-repo-dir", "disk-space", "lock-dir", "state-dir"]) {
        expect(byCheck(checks, id, name), `${name} › ${id}`).toBeDefined();
      }
    }
    expect(doctorExitCode(checks)).toBe(0);
  });

  it("skips the bare repository check for a clone-mode repository", async () => {
    const d = deps({ loadRepositories: async () => [repo({ mode: "clone", bareRepoDir: undefined })] });
    const checks = await runDoctorChecks({}, d);
    expect(byCheck(checks, "bare-repo-dir", "app")).toBeUndefined();
    expect(byCheck(checks, "worktree-dir", "app")).toBeDefined();
  });

  it("passes --config and --filter through, resolving the path", async () => {
    const d = deps();
    await runDoctorChecks({ config: "cfg.js", filter: "app" }, d);
    expect(d.loadRepositories).toHaveBeenCalledWith(path.resolve("cfg.js"), "app");
    expect(d.findConfig).not.toHaveBeenCalled();
  });

  it("fails when no config file is found", async () => {
    const checks = await runDoctorChecks({}, deps({ findConfig: async () => null }));
    expect(byCheck(checks, "config")?.status).toBe("fail");
    expect(byCheck(checks, "config")?.hint).toContain("sync-worktrees init");
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("fails a --config path that does not exist", async () => {
    const checks = await runDoctorChecks(
      { config: "/nope.js" },
      deps({
        loadRepositories: async () => {
          throw new ConfigFileNotFoundError("/nope.js");
        },
      }),
    );
    expect(byCheck(checks, "config")?.message).toBe("Config file not found: /nope.js");
  });

  it("fails an invalid config with the loader's reason, redacted", async () => {
    const checks = await runDoctorChecks(
      {},
      deps({
        loadRepositories: async () => {
          throw new Error("Failed to load config file: repoUrl https://me:tok3n@example.com/x.git is invalid");
        },
      }),
    );
    const config = byCheck(checks, "config");
    expect(config?.status).toBe("fail");
    expect(config?.message).toContain("does not load: repoUrl https://***@example.com/x.git is invalid");
    expect(JSON.stringify(checks)).not.toContain("tok3n");
  });

  it("fails a filter that matches nothing", async () => {
    const checks = await runDoctorChecks({ filter: "nothing" }, deps({ loadRepositories: async () => [] }));
    expect(byCheck(checks, "config")?.status).toBe("fail");
    expect(byCheck(checks, "config")?.message).toContain("filter 'nothing'");
  });

  it("stops after the config check when git cannot run, instead of failing every repository check", async () => {
    const checks = await runDoctorChecks({}, deps({ runGit: async () => enoent() }));
    expect(checks.map((item) => item.check)).toEqual(["node", "git", "config"]);
    expect(doctorExitCode(checks)).toBe(1);
  });

  it("exits 0 with warnings only", async () => {
    const checks = await runDoctorChecks({}, deps({ nodeVersion: "22.0.0" }));
    expect(checks.some((item) => item.status === "warn")).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
  });
});

describe("formatDoctorReport", () => {
  const checks: DoctorCheck[] = [
    { check: "node", repository: null, status: "pass", message: "Node.js 24", hint: null },
    { check: "git", repository: null, status: "warn", message: "old git", hint: "upgrade" },
    { check: "remote", repository: "app", status: "fail", message: "unreachable", hint: "check the URL" },
  ];

  it("prints a line per check, a hint under each problem and a count", () => {
    const lines = formatDoctorReport(checks);
    expect(lines).toEqual([
      "✅ PASS  node: Node.js 24",
      "⚠️  WARN  git: old git",
      "   💡 upgrade",
      "❌ FAIL  app › remote: unreachable",
      "   💡 check the URL",
      "",
      "🩺 1 passed, 1 warning, 1 failed",
    ]);
  });

  it("drops passing lines under quiet", () => {
    const lines = formatDoctorReport(checks, { quiet: true });
    expect(lines.some((line) => line.includes("PASS"))).toBe(false);
    expect(lines.at(-1)).toBe("🩺 1 passed, 1 warning, 1 failed");
  });

  it("prints only the count under quiet when everything passed", () => {
    expect(formatDoctorReport([checks[0]], { quiet: true })).toEqual(["🩺 1 passed, 0 warnings, 0 failed"]);
  });

  it("colours the status word only when colour is on", () => {
    expect(formatDoctorReport(checks, { color: true })[0]).toContain("\u001b[32mPASS\u001b[0m");
    expect(formatDoctorReport(checks, { color: false }).join("\n")).not.toContain("\u001b[");
  });
});

describe("runDoctor", () => {
  it("prints one JSON array and returns 1 when something failed", async () => {
    const lines: string[] = [];
    const code = await runDoctor({ json: true, quiet: true }, deps({ findConfig: async () => null }), (line) =>
      lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as DoctorCheck[];
    expect(parsed.map((item) => item.check)).toEqual(["node", "git", "git-lfs", "config"]);
    expect(parsed[0]).toEqual({
      check: "node",
      repository: null,
      status: "pass",
      message: expect.any(String),
      hint: null,
    });
  });

  it("follows NO_COLOR for the report", async () => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("NO_COLOR", "1");
    const lines: string[] = [];
    const code = await runDoctor({}, deps(), (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("\u001b[");
  });
});

describe("runGitNonInteractive", () => {
  let server: http.Server | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("runs git and captures its output", async () => {
    const result = await runGitNonInteractive(["--version"], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });

  it("reports a git that cannot be started instead of throwing", async () => {
    vi.stubEnv("PATH", "/nonexistent-doctor-path");
    const result = await runGitNonInteractive(["--version"], { timeoutMs: 10_000 });
    expect(result.spawnError).toBeDefined();
    expect(result.code).toBeNull();
  });

  it("kills a remote that never answers once the timeout passes", async () => {
    // Accepts the connection and never responds, like a black-holed proxy.
    server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const startedAt = Date.now();
    const result = await runGitNonInteractive(["ls-remote", "--heads", `http://127.0.0.1:${port}/app.git`], {
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    server.closeAllConnections();
  });

  it("answers a credential prompt with a failure rather than a prompt, even if the user enabled prompts", async () => {
    vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
    server = http.createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="doctor"' });
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-git-"));
    const result = await runGitNonInteractive(["ls-remote", "--heads", `http://127.0.0.1:${port}/app.git`], {
      cwd: tempDir,
      timeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("terminal prompts disabled");
  });
});
