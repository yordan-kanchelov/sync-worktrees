import { describe, expect, it } from "vitest";

import {
  GIT_REPOSITORY_SELECTION_VARS,
  GIT_UNSAFE_ALLOWANCES,
  sanitizeGitEnv,
  stripGitRepositorySelection,
} from "../git-env";

describe("sanitizeGitEnv", () => {
  const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/probe", SSH_AUTH_SOCK: "/tmp/agent.sock" };

  it("forwards the parent environment and strips the editor variables", () => {
    const env = sanitizeGitEnv({ ...base, EDITOR: "vim", GIT_EDITOR: "nano", GIT_SEQUENCE_EDITOR: "code --wait" });

    expect(env).toMatchObject(base);
    expect(env).not.toHaveProperty("EDITOR");
    expect(env).not.toHaveProperty("GIT_EDITOR");
    expect(env).not.toHaveProperty("GIT_SEQUENCE_EDITOR");
  });

  // simple-git only sets the child's cwd, so each of these outranks the
  // baseDir a client was built with: the eight that redirect point git at
  // another repository, working tree, index or object store, and the two that
  // bound discovery can take the checkout away entirely. git hands GIT_DIR and
  // GIT_INDEX_FILE to some of its own hooks (see GIT_REPOSITORY_SELECTION_VARS
  // in ../git-env for which), so a sync-worktrees run started from one inherits
  // them without anybody exporting anything.
  it("strips every repository-selection variable", () => {
    const env = sanitizeGitEnv({
      ...base,
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/.git/index",
      GIT_COMMON_DIR: "/elsewhere/.git",
      GIT_OBJECT_DIRECTORY: "/elsewhere/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/elsewhere/.git/objects",
      GIT_NAMESPACE: "tenant",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_CONFIG: "/elsewhere/config",
    });

    for (const name of GIT_REPOSITORY_SELECTION_VARS) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env).toMatchObject(base);
  });

  // The other half of the same decision: what reaches git has to keep
  // authenticating, finding git, and reading the configuration the caller
  // chose for whichever repository we picked.
  it("keeps the authentication, discovery-independent and config-content variables", () => {
    const env = sanitizeGitEnv({
      ...base,
      GIT_DIR: "/elsewhere/.git",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_ASKPASS: "/usr/bin/ssh-askpass",
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/work_key",
      GIT_PROXY_COMMAND: "/usr/bin/proxy",
      GIT_EXEC_PATH: "/usr/lib/git-core",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "store",
      GIT_INDEX_VERSION: "4",
      GIT_DEFAULT_HASH: "sha256",
      GIT_PREFIX: "sub/",
    });

    expect(env).not.toHaveProperty("GIT_DIR");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/probe",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_ASKPASS: "/usr/bin/ssh-askpass",
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/work_key",
      GIT_PROXY_COMMAND: "/usr/bin/proxy",
      GIT_EXEC_PATH: "/usr/lib/git-core",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "store",
      GIT_INDEX_VERSION: "4",
      GIT_DEFAULT_HASH: "sha256",
      GIT_PREFIX: "sub/",
    });
  });

  it("does not mutate the environment it is given", () => {
    const input: NodeJS.ProcessEnv = { ...base, EDITOR: "vim" };

    sanitizeGitEnv(input);

    expect(input).toEqual({ ...base, EDITOR: "vim" });
  });

  it("does not mutate the environment it is given while stripping GIT_DIR", () => {
    const input: NodeJS.ProcessEnv = { ...base, GIT_DIR: "/elsewhere/.git" };

    sanitizeGitEnv(input);

    expect(input).toEqual({ ...base, GIT_DIR: "/elsewhere/.git" });
  });

  // git prompts for credentials on /dev/tty whenever a terminal is attached,
  // regardless of stdio pipes; in the TUI that prompt can never be answered.
  it("disables git's terminal credential prompt", () => {
    expect(sanitizeGitEnv(base).GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("preserves a user-set GIT_TERMINAL_PROMPT", () => {
    expect(sanitizeGitEnv({ ...base, GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe("1");
    expect(sanitizeGitEnv({ ...base, GIT_TERMINAL_PROMPT: "" }).GIT_TERMINAL_PROMPT).toBe("");
  });

  // git gives GIT_SSH_COMMAND precedence over the core.sshCommand config key,
  // so no ssh command may be injected here: it would silently replace a
  // user's configured one (includeIf keys, `ssh -i work_key`, agent wrappers).
  it("never adds an ssh command of its own", () => {
    const env = sanitizeGitEnv(base);

    expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
    expect(env).not.toHaveProperty("GIT_SSH");
  });

  it("leaves a user-provided GIT_SSH_COMMAND untouched", () => {
    const env = sanitizeGitEnv({ ...base, GIT_SSH_COMMAND: "ssh -i ~/.ssh/work_key" });

    expect(env.GIT_SSH_COMMAND).toBe("ssh -i ~/.ssh/work_key");
  });

  it("leaves a user-provided GIT_SSH untouched and adds no GIT_SSH_COMMAND", () => {
    const env = sanitizeGitEnv({ ...base, GIT_SSH: "/usr/local/bin/plink" });

    expect(env.GIT_SSH).toBe("/usr/local/bin/plink");
    expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
  });
});

describe("GIT_UNSAFE_ALLOWANCES", () => {
  // One entry per environment variable @simple-git/argv-parser maps to an
  // allowance (plus credential.helper through GIT_CONFIG_KEY_n). A forwarded
  // shell environment must never make a git call throw.
  it("covers every environment variable simple-git validates", () => {
    expect(GIT_UNSAFE_ALLOWANCES).toEqual({
      allowUnsafeAskPass: true,
      allowUnsafeConfigEnvCount: true,
      allowUnsafeConfigPaths: true,
      allowUnsafeCredentialHelper: true,
      allowUnsafeDiffExternal: true,
      allowUnsafeGitProxy: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeTemplateDir: true,
    });
  });

  it("keeps the argument-only protections in place", () => {
    expect(GIT_UNSAFE_ALLOWANCES).not.toHaveProperty("allowUnsafePack");
    expect(GIT_UNSAFE_ALLOWANCES).not.toHaveProperty("allowUnsafeProtocolOverride");
    expect(GIT_UNSAFE_ALLOWANCES).not.toHaveProperty("allowUnsafeHooksPath");
    expect(GIT_UNSAFE_ALLOWANCES).not.toHaveProperty("allowUnsafeEditor");
  });

  it("is frozen so no client can widen it in place", () => {
    expect(Object.isFrozen(GIT_UNSAFE_ALLOWANCES)).toBe(true);
  });
});

describe("GIT_REPOSITORY_SELECTION_VARS", () => {
  // Spelled out rather than derived, so adding or dropping one is a deliberate
  // edit with a reason: each entry is a variable git reads instead of the
  // directory a command runs in, and everything else git honours stays.
  it("is git's repository-selection set and nothing else", () => {
    expect([...GIT_REPOSITORY_SELECTION_VARS]).toEqual([
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM",
      "GIT_CONFIG",
    ]);
  });

  it("is frozen so no caller can narrow it in place", () => {
    expect(Object.isFrozen(GIT_REPOSITORY_SELECTION_VARS)).toBe(true);
  });
});

describe("stripGitRepositorySelection", () => {
  it("drops the selection variables and keeps everything else", () => {
    const stripped = stripGitRepositorySelection({
      PATH: "/usr/bin",
      EDITOR: "vim",
      GIT_DIR: "/elsewhere/.git",
      GIT_INDEX_FILE: ".git/index",
    });

    expect(stripped).toEqual({ PATH: "/usr/bin", EDITOR: "vim" });
  });

  // Unlike sanitizeGitEnv this one is also used for the user's hook commands,
  // where an editor, a pager and a terminal prompt are all legitimate.
  it("adds nothing of its own", () => {
    expect(stripGitRepositorySelection({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it("does not mutate the environment it is given", () => {
    const input: NodeJS.ProcessEnv = { PATH: "/usr/bin", GIT_WORK_TREE: "/elsewhere" };

    stripGitRepositorySelection(input);

    expect(input).toEqual({ PATH: "/usr/bin", GIT_WORK_TREE: "/elsewhere" });
  });
});
