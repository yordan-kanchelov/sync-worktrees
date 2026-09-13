import { describe, expect, it } from "vitest";

import { GIT_UNSAFE_ALLOWANCES, sanitizeGitEnv } from "../git-env";

describe("sanitizeGitEnv", () => {
  const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/probe", SSH_AUTH_SOCK: "/tmp/agent.sock" };

  it("forwards the parent environment and strips the editor variables", () => {
    const env = sanitizeGitEnv({ ...base, EDITOR: "vim", GIT_EDITOR: "nano", GIT_SEQUENCE_EDITOR: "code --wait" });

    expect(env).toMatchObject(base);
    expect(env).not.toHaveProperty("EDITOR");
    expect(env).not.toHaveProperty("GIT_EDITOR");
    expect(env).not.toHaveProperty("GIT_SEQUENCE_EDITOR");
  });

  it("does not mutate the environment it is given", () => {
    const input: NodeJS.ProcessEnv = { ...base, EDITOR: "vim" };

    sanitizeGitEnv(input);

    expect(input).toEqual({ ...base, EDITOR: "vim" });
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
