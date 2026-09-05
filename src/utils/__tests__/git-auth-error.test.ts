import { describe, expect, it } from "vitest";

import {
  GIT_AUTH_ERROR_PATTERNS,
  appendGitAuthHint,
  getGitAuthHint,
  isGitAuthError,
  isGitAuthErrorFromError,
  withGitAuthHint,
} from "../git-auth-error";

const HTTPS_PROMPT = "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
const HTTPS_PASSWORD = "fatal: could not read Password for 'https://user@github.com': terminal prompts disabled\n";
const HTTPS_REJECTED =
  "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/org/repo.git/'\n";
const SSH_KEY = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n";
const SSH_KEY_PASSWORD =
  "user@host: Permission denied (publickey,password).\nfatal: Could not read from remote repository.\n";
const SSH_PASSWORD = "user@host: Permission denied (password).\nfatal: Could not read from remote repository.\n";
const SSH_HOST_KEY = "Host key verification failed.\nfatal: Could not read from remote repository.\n";
const NETWORK = "fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host: github.com\n";

describe("isGitAuthError", () => {
  it.each([HTTPS_PROMPT, HTTPS_PASSWORD, HTTPS_REJECTED, SSH_KEY, SSH_KEY_PASSWORD, SSH_PASSWORD, SSH_HOST_KEY])(
    "detects %s",
    (message) => {
      expect(isGitAuthError(message)).toBe(true);
    },
  );

  it.each([NETWORK, "fatal: Could not read from remote repository.", "smudge filter lfs failed", ""])(
    "does not flag %s",
    (message) => {
      expect(isGitAuthError(message)).toBe(false);
    },
  );

  it("matches every published pattern", () => {
    for (const pattern of GIT_AUTH_ERROR_PATTERNS) {
      expect(isGitAuthError(`prefix ${pattern} suffix`)).toBe(true);
    }
  });

  it("reads the message out of an error object", () => {
    expect(isGitAuthErrorFromError(new Error(SSH_KEY))).toBe(true);
    expect(isGitAuthErrorFromError({ message: HTTPS_PROMPT })).toBe(true);
    expect(isGitAuthErrorFromError(new Error(NETWORK))).toBe(false);
    expect(isGitAuthErrorFromError(undefined)).toBe(false);
  });
});

describe("getGitAuthHint", () => {
  it("points HTTPS credential failures at a credential helper", () => {
    for (const message of [HTTPS_PROMPT, HTTPS_PASSWORD, HTTPS_REJECTED]) {
      const hint = getGitAuthHint(message);
      expect(hint).toContain("GIT_TERMINAL_PROMPT=0");
      expect(hint).toContain("credential helper");
    }
  });

  it("points ssh authentication failures at ssh-agent without touching the ssh command", () => {
    for (const message of [SSH_KEY, SSH_KEY_PASSWORD, SSH_PASSWORD]) {
      const hint = getGitAuthHint(message);
      expect(hint).toContain("ssh-agent");
      expect(hint).not.toContain("GIT_SSH_COMMAND");
    }
  });

  it("points host key failures at known_hosts", () => {
    const hint = getGitAuthHint(SSH_HOST_KEY);
    expect(hint).toContain("known_hosts");
    expect(hint).toContain("ssh-keyscan");
  });

  it("has no hint for other failures", () => {
    expect(getGitAuthHint(NETWORK)).toBeUndefined();
  });

  it("keeps every hint on one line", () => {
    for (const message of [HTTPS_PROMPT, SSH_KEY, SSH_HOST_KEY]) {
      expect(getGitAuthHint(message)).not.toContain("\n");
    }
  });
});

describe("appendGitAuthHint", () => {
  it("appends the hint on its own line after git's trimmed message", () => {
    const hinted = appendGitAuthHint(HTTPS_PROMPT);

    expect(hinted.startsWith(HTTPS_PROMPT.trimEnd())).toBe(true);
    expect(hinted).toMatch(/terminal prompts disabled\nHint: /);
    expect(hinted).toContain(getGitAuthHint(HTTPS_PROMPT));
  });

  it("appends the hint only once", () => {
    const once = appendGitAuthHint(SSH_KEY);

    expect(appendGitAuthHint(once)).toBe(once);
    expect(appendGitAuthHint(`Failed to sync repository 'app': ${once}`).match(/Hint: /g)).toHaveLength(1);
  });

  it("returns other messages unchanged", () => {
    expect(appendGitAuthHint(NETWORK)).toBe(NETWORK);
    expect(appendGitAuthHint("")).toBe("");
  });
});

describe("withGitAuthHint", () => {
  it("wraps an authentication error, keeping the original as cause", () => {
    const original = new Error(SSH_HOST_KEY);

    const wrapped = withGitAuthHint(original);

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(original);
    expect((wrapped as Error).message).toBe(appendGitAuthHint(SSH_HOST_KEY));
    expect((wrapped as Error).cause).toBe(original);
  });

  it("returns any other error untouched", () => {
    const network = new Error(NETWORK);
    expect(withGitAuthHint(network)).toBe(network);

    const hinted = new Error(appendGitAuthHint(HTTPS_PROMPT));
    expect(withGitAuthHint(hinted)).toBe(hinted);
  });

  it("returns non-Error values as they are", () => {
    expect(withGitAuthHint(HTTPS_PROMPT)).toBe(HTTPS_PROMPT);
    expect(withGitAuthHint(undefined)).toBeUndefined();
  });
});
