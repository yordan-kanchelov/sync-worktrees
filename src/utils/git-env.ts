import type { SimpleGitOptions } from "simple-git";

/**
 * simple-git validates every explicit `.env()` object against the environment
 * variables git itself honours (@simple-git/argv-parser `parseEnv`) and refuses
 * to spawn unless the matching `unsafe` allowance is set. That check exists
 * for library callers passing untrusted env; every client here forwards the
 * user's own (sanitized) shell environment by design, so the allowance set
 * covers each variable the parser maps — a shell exporting `PAGER` or a CI
 * job exporting `GIT_CONFIG_COUNT` must not make every git call throw:
 *
 * - allowUnsafeAskPass: GIT_ASKPASS, SSH_ASKPASS (VS Code's askpass bridge)
 * - allowUnsafeConfigEnvCount: GIT_CONFIG_COUNT (+ GIT_CONFIG_KEY_n / VALUE_n)
 * - allowUnsafeConfigPaths: GIT_CONFIG, GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
 *   GIT_EXEC_PATH, PREFIX
 * - allowUnsafeCredentialHelper: a `credential.helper` entry supplied through
 *   GIT_CONFIG_KEY_n — the documented way for CI to inject a helper, and the
 *   remedy suggested for the "terminal prompts disabled" failure
 * - allowUnsafeDiffExternal: GIT_EXTERNAL_DIFF
 * - allowUnsafeGitProxy: GIT_PROXY_COMMAND
 * - allowUnsafePager: PAGER, GIT_PAGER
 * - allowUnsafeSshCommand: GIT_SSH, GIT_SSH_COMMAND exported by the user
 * - allowUnsafeTemplateDir: GIT_TEMPLATE_DIR
 *
 * EDITOR / GIT_EDITOR / GIT_SEQUENCE_EDITOR are stripped by sanitizeGitEnv
 * instead of allowed: no command run here should ever open an editor.
 * Allowances that only guard command-line arguments (--upload-pack,
 * protocol.allow, hooksPath, ...) stay off so branch names and URLs that reach
 * git arguments keep simple-git's protection.
 *
 * Consequence of every client passing an explicit env: a GIT_CONFIG_KEY_n
 * entry naming a config key outside this set (core.hooksPath, core.editor,
 * alias.*, gpg.program, filter.*, ...) is rejected by simple-git's env
 * validation for every client, where the env-less clients of earlier releases
 * inherited it unchecked. The error names the missing allowance; unsetting the
 * variable or moving the setting into a git config file resolves it.
 */
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

/**
 * The environment every git subprocess runs with. Starts from the parent
 * environment — simple-git's .env() REPLACES the child environment wholesale
 * (no merge with process.env), and a child without PATH/HOME/SSH_AUTH_SOCK
 * cannot authenticate or find git — and then:
 *
 * - strips EDITOR / GIT_EDITOR / GIT_SEQUENCE_EDITOR so a shell editor never
 *   opens from a read-only command;
 * - sets GIT_TERMINAL_PROMPT=0 unless the user set it: git prompts for
 *   credentials on /dev/tty whenever a terminal is attached, regardless of
 *   stdio pipes. In the TUI that prompt lands inside the Ink frame and can
 *   never be answered, so the fetch only ends when the inactivity timeout kills
 *   it; with prompts disabled git fails at once with "could not read Username
 *   ...: terminal prompts disabled". An askpass program (GIT_ASKPASS,
 *   core.askPass, SSH_ASKPASS) still takes precedence over the terminal, so a
 *   GUI credential bridge keeps working.
 *
 * ssh is deliberately left alone. git gives GIT_SSH_COMMAND precedence over
 * the `core.sshCommand` config key (verified on git 2.43: env + config runs
 * the env command; legacy GIT_SSH + config runs the config command), so a
 * "ssh -o BatchMode=yes" default injected here would silently replace a
 * user's configured ssh command — includeIf keys, `ssh -i work_key`, agent
 * wrappers — and nothing synchronous in this factory can read that config.
 * Known limitation: GIT_TERMINAL_PROMPT=0 covers git's own prompts only; ssh
 * reads a key passphrase or an unknown-host confirmation from /dev/tty itself,
 * so a passphrase-protected key without an agent or a host missing from
 * known_hosts still blocks until the inactivity timeout (pre-existing
 * behaviour). A per-repository core.sshCommand-aware BatchMode wrapper is a
 * follow-up.
 */
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.EDITOR;
  delete sanitized.GIT_EDITOR;
  delete sanitized.GIT_SEQUENCE_EDITOR;
  if (sanitized.GIT_TERMINAL_PROMPT === undefined) {
    sanitized.GIT_TERMINAL_PROMPT = "0";
  }
  return sanitized;
}
