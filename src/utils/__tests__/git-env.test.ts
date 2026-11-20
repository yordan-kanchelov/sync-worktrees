import { describe, expect, it } from "vitest";

import {
  GIT_REPOSITORY_SELECTION_VARS,
  GIT_UNSAFE_ALLOWANCES,
  sanitizeGitEnv,
  sshNoPromptEnv,
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

  it("disables git's terminal credential prompt", () => {
    expect(sanitizeGitEnv(base).GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("preserves a user-set GIT_TERMINAL_PROMPT", () => {
    expect(sanitizeGitEnv({ ...base, GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe("1");
    expect(sanitizeGitEnv({ ...base, GIT_TERMINAL_PROMPT: "" }).GIT_TERMINAL_PROMPT).toBe("");
  });

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

  it("is frozen so no client can widen it in place", () => {
    expect(Object.isFrozen(GIT_UNSAFE_ALLOWANCES)).toBe(true);
  });
});

describe("GIT_REPOSITORY_SELECTION_VARS", () => {
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

  it("adds nothing of its own", () => {
    expect(stripGitRepositorySelection({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it("does not mutate the environment it is given", () => {
    const input: NodeJS.ProcessEnv = { PATH: "/usr/bin", GIT_WORK_TREE: "/elsewhere" };

    stripGitRepositorySelection(input);

    expect(input).toEqual({ PATH: "/usr/bin", GIT_WORK_TREE: "/elsewhere" });
  });
});

describe("sshNoPromptEnv", () => {
  const SSH_URLS = ["git@github.com:org/repo.git", "ssh://git@github.com/org/repo.git", "SSH://host.example/repo.git"];
  const NO_PROMPT = { SSH_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "force" };

  it.each(SSH_URLS)("routes ssh's prompts to a failing askpass for %s", (url) => {
    expect(sshNoPromptEnv(url, { PATH: "/usr/bin" }, "linux")).toEqual(NO_PROMPT);
    expect(sshNoPromptEnv(url, { PATH: "/usr/bin" }, "darwin")).toEqual(NO_PROMPT);
  });

  it.each(["https://github.com/org/repo.git", "http://127.0.0.1:8080/r.git", "/srv/repo.git", "file:///srv/r"])(
    "adds nothing for a repository not reached over ssh (%s)",
    (url) => {
      expect(sshNoPromptEnv(url, { PATH: "/usr/bin" }, "linux")).toEqual({});
    },
  );

  it("never sets an ssh command", () => {
    const env = sshNoPromptEnv(SSH_URLS[0], { GIT_SSH_COMMAND: "ssh -i ~/.ssh/work_key" }, "linux");

    expect(env).toEqual(NO_PROMPT);
    expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
    expect(env).not.toHaveProperty("GIT_SSH");
  });

  it("leaves a user's own askpass setup alone", () => {
    expect(sshNoPromptEnv(SSH_URLS[0], { SSH_ASKPASS: "/usr/bin/ksshaskpass" }, "linux")).toEqual({});
    expect(sshNoPromptEnv(SSH_URLS[0], { SSH_ASKPASS_REQUIRE: "never" }, "linux")).toEqual({});
  });

  it("follows the user's GIT_TERMINAL_PROMPT: prompts they asked for stay on", () => {
    expect(sshNoPromptEnv(SSH_URLS[0], { GIT_TERMINAL_PROMPT: "1" }, "linux")).toEqual({});
    expect(sshNoPromptEnv(SSH_URLS[0], { GIT_TERMINAL_PROMPT: "true" }, "linux")).toEqual({});
    for (const disabled of ["0", "false", "No", "off", ""]) {
      expect(sshNoPromptEnv(SSH_URLS[0], { GIT_TERMINAL_PROMPT: disabled }, "linux")).toEqual(NO_PROMPT);
    }
  });

  it("adds nothing on Windows", () => {
    expect(sshNoPromptEnv(SSH_URLS[0], {}, "win32")).toEqual({});
  });
});
