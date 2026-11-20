import { parseGitUrl } from "./git-url";

import type { SimpleGitOptions } from "simple-git";

export const GIT_UNSAFE_ALLOWANCES: Readonly<NonNullable<SimpleGitOptions["unsafe"]>> = Object.freeze({
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

export const GIT_REPOSITORY_SELECTION_VARS: readonly string[] = Object.freeze([
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

export function stripGitRepositorySelection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = { ...env };
  for (const name of GIT_REPOSITORY_SELECTION_VARS) {
    delete stripped[name];
  }
  return stripped;
}

export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = stripGitRepositorySelection(env);
  delete sanitized.EDITOR;
  delete sanitized.GIT_EDITOR;
  delete sanitized.GIT_SEQUENCE_EDITOR;
  if (sanitized.GIT_TERMINAL_PROMPT === undefined) {
    sanitized.GIT_TERMINAL_PROMPT = "0";
  }
  return sanitized;
}

const PROMPT_DISABLED_VALUES = new Set(["", "0", "false", "no", "off"]);

function usesSshTransport(repoUrl: string): boolean {
  return /^ssh:\/\//i.test(repoUrl) || parseGitUrl(repoUrl)?.kind === "scp";
}

export function sshNoPromptEnv(
  repoUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32" || !usesSshTransport(repoUrl)) return {};
  if (env.SSH_ASKPASS !== undefined || env.SSH_ASKPASS_REQUIRE !== undefined) return {};
  const terminalPrompt = env.GIT_TERMINAL_PROMPT;
  if (terminalPrompt !== undefined && !PROMPT_DISABLED_VALUES.has(terminalPrompt.trim().toLowerCase())) return {};
  return { SSH_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "force" };
}
