import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { buildGitClientOptions, createGitClient } from "../git-client";
import { GIT_UNSAFE_ALLOWANCES, sanitizeGitEnv } from "../git-env";

import type { AddressInfo } from "net";

// Real git, no mocks: these tests prove the environment the factory forwards
// is one git and simple-git accept, and that git behaves non-interactively.

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) setEnvVar(key, value);
}

describe("buildGitClientOptions", () => {
  it("adds the centralized unsafe-env allowances to the caller's options", () => {
    const progress = (): void => {};

    expect(buildGitClientOptions({ progress, timeout: { block: 5 } })).toEqual({
      progress,
      timeout: { block: 5 },
      unsafe: GIT_UNSAFE_ALLOWANCES,
    });
    expect(buildGitClientOptions()).toEqual({ unsafe: GIT_UNSAFE_ALLOWANCES });
  });

  it("merges caller allowances on top of the centralized set", () => {
    expect(buildGitClientOptions({ unsafe: { allowUnsafePack: true } }).unsafe).toEqual({
      ...GIT_UNSAFE_ALLOWANCES,
      allowUnsafePack: true,
    });
  });
});

describe("createGitClient with a forwarded shell environment", () => {
  // Every variable @simple-git/argv-parser maps to an allowance, plus a
  // credential.helper entry supplied through GIT_CONFIG_KEY_n.
  const PARSER_CHECKED_ENV: Record<string, string> = {
    PAGER: "less",
    GIT_PAGER: "less",
    GIT_SSH_COMMAND: "ssh -i /nonexistent/work_key",
    GIT_SSH: "ssh",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "store",
    GIT_EXTERNAL_DIFF: "/bin/false",
    GIT_PROXY_COMMAND: "/bin/false",
    GIT_TEMPLATE_DIR: "/nonexistent/git-templates",
    PREFIX: "/usr/local",
  };
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv(Object.keys(PARSER_CHECKED_ENV));
    for (const [key, value] of Object.entries(PARSER_CHECKED_ENV)) setEnvVar(key, value);
  });

  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("runs git although the environment carries every variable simple-git validates", async () => {
    await expect(createGitClient().raw(["--version"])).resolves.toMatch(/^git version/);
  });

  it("would be rejected by the previous, narrower allowance set", async () => {
    const narrow = simpleGit({ unsafe: { allowUnsafeAskPass: true, allowUnsafeConfigEnvCount: true } }).env(
      sanitizeGitEnv(process.env),
    );

    await expect(narrow.raw(["--version"])).rejects.toThrow(/allowUnsafe/);
  });
});

describe("createGitClient against an HTTPS remote that requires authentication", () => {
  // A credential source could otherwise answer for us; none may be in play:
  // no helper (fresh HOME, no system config), no askpass, no inherited
  // GIT_TERMINAL_PROMPT (the fix must be what disables the prompt).
  const scrubbedKeys = (): string[] => [
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TERMINAL_PROMPT",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_CONFIG_COUNT",
    ...Object.keys(process.env).filter((key) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)),
  ];
  let snapshot: Map<string, string | undefined>;
  let home: string;
  let repoDir: string;
  let server: http.Server;
  let remoteUrl: string;
  const requests: string[] = [];

  beforeEach(async () => {
    snapshot = snapshotEnv(scrubbedKeys());
    home = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-auth-probe-"));
    repoDir = path.join(home, "repo");
    await fs.mkdir(repoDir);
    for (const key of scrubbedKeys()) setEnvVar(key, undefined);
    setEnvVar("HOME", home);
    setEnvVar("XDG_CONFIG_HOME", home);
    setEnvVar("GIT_CONFIG_NOSYSTEM", "1");

    requests.length = 0;
    server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="sync-worktrees-test"' });
      res.end("authentication required");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private/repo.git`;

    await createGitClient(repoDir).init();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv(snapshot);
    await fs.rm(home, { recursive: true, force: true });
  });

  it("fails within seconds with git's 'terminal prompts disabled' message instead of waiting for a prompt", async () => {
    const started = Date.now();
    // The block timeout is a backstop only: without the fix and with a
    // terminal attached, git would wait on its prompt until it fires.
    const client = createGitClient(repoDir, {}, { timeout: { block: 20_000 } });

    await expect(client.fetch([remoteUrl])).rejects.toThrow(
      /could not read Username for 'http:\/\/127\.0\.0\.1:\d+': terminal prompts disabled/,
    );

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(requests).toContain("/private/repo.git/info/refs?service=git-upload-pack");
  });
});
