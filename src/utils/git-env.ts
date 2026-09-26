import { parseGitUrl } from "./git-url";

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
 * - allowUnsafeConfigPaths: GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
 *   GIT_EXEC_PATH, PREFIX (GIT_CONFIG is stripped, see below)
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
 * The variables that let an inherited environment, rather than the directory a
 * command runs in, decide which repository a git command works on. simple-git
 * only ever sets the child's `cwd`, so each of these silently outranks the
 * `baseDir` a client was built with.
 *
 * Eight of them redirect: the command runs against whatever repository, working
 * tree, index or object store the variable names. The last two are the opposite
 * shape — GIT_CEILING_DIRECTORIES and GIT_DISCOVERY_ACROSS_FILESYSTEM bound the
 * upward search instead of redirecting it, and neither is known to reach a
 * command this tool runs. A ceiling only bites a search that has to ascend, and
 * every client here is handed a repository root: measured on git 2.43, with cwd
 * AT the root, a ceiling naming that root and a ceiling naming its parent both
 * leave `rev-parse --git-dir` reporting `.git`; only from a subdirectory does
 * the same ceiling produce "fatal: not a git repository". Crossing-filesystems
 * is the other direction again — an inherited `=1` only lets discovery ascend
 * past a mount boundary it would otherwise refuse, so it adds rather than
 * subtracts, and no measurement of it was possible here. Both are stripped
 * anyway: neither can help a client that already knows its root, and the cost
 * of carrying them is a discovery rule nobody chose.
 *
 * Four of them arrive without anyone exporting anything, and only from some of
 * the places a hook runs. Measured on git 2.43 by dumping a hook's own
 * environment:
 *
 * - in a linked worktree, post-checkout, post-commit and post-merge all carry
 *   GIT_DIR=<main>/.git/worktrees/<name> — absolute, and a real repository;
 * - a bare repository's receive hooks (pre-receive, update, post-receive,
 *   post-update) carry the relative GIT_DIR=.;
 * - pre-receive alone also carries the push quarantine: GIT_OBJECT_DIRECTORY
 *   naming <bare>/objects/tmp_objdir-incoming-XXXXXX and
 *   GIT_ALTERNATE_OBJECT_DIRECTORIES naming <bare>/objects. The other three
 *   receive hooks carry neither — the quarantine is folded in before `update`
 *   runs, and its directory is deleted when the push finishes (measured: the
 *   path from the hook's own environment is gone once the push returns);
 * - the commit hooks carry GIT_INDEX_FILE: in a main worktree the relative
 *   .git/index, in a linked worktree that worktree's index by absolute path;
 * - in a main worktree, post-checkout and post-merge carry no selection
 *   variable at all, and post-commit carries only the relative index path,
 *   which follows the command's own directory instead of naming another
 *   repository — harmless on a plain checkout, though not on a linked worktree
 *   (see GIT_INDEX_FILE below);
 * - nothing else on this list reaches any hook. GIT_COMMON_DIR, GIT_NAMESPACE,
 *   GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM and GIT_CONFIG
 *   arrive only from a shell or CI job that exports them.
 *
 * The two hook shapes are hazardous in different ways, and it is worth keeping
 * them apart. A hook running in a linked worktree hands over an absolute
 * GIT_DIR, and that one really does aim a whole tick at another repository. A
 * receive hook hands over the relative GIT_DIR=., which aims nothing anywhere:
 * one directory below a repository it resolves to no repository at all, so
 * every phase of the tick dies at once with "fatal: not a git repository: '.'"
 * (measured from a checkout: config --get-all, update-ref -d, rev-parse and
 * fetch all exit non-zero without touching anything). What a pre-receive hook
 * does misdirect is the object store, through the two quarantine variables —
 * see GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES below. A
 * `post-checkout` or `post-commit` in a plain checkout hands over nothing that
 * redirects.
 *
 * What each one does once it is inherited. Measured on git 2.43 with raw git
 * from a checkout B, the variable aimed at an unrelated repository A — this is
 * what the variable makes possible, not a list of things this tool does:
 *
 * - GIT_DIR            `config --replace-all` rewrote A's remote.origin.fetch
 *                      and `update-ref -d` deleted A's remote-tracking ref,
 *                      while B kept its own — which is exactly what clone mode's
 *                      refspec convergence and stale-ref sweep run. In the
 *                      relative `GIT_DIR=.` form, inherited one directory below
 *                      the repository, every command instead fails with "fatal:
 *                      not a git repository: '.'".
 * - GIT_WORK_TREE      `checkout -- .` in B wrote B's blob over A's file of the
 *                      same name.
 * - GIT_COMMON_DIR     a `git config` write landed in A's config file.
 * - GIT_INDEX_FILE     `git add` of a file in B staged it into A's index. This
 *                      tool stages nothing; what it puts near an index is
 *                      `checkout` and `merge --ff-only`. In the relative
 *                      `.git/index` form, inherited by a client on a linked
 *                      worktree — whose `.git` is a file, not a directory —
 *                      every command fails with "fatal: .git/index: index file
 *                      open failed: Not a directory".
 * - GIT_OBJECT_DIRECTORY
 *                      `hash-object -w` in B wrote the loose object into A's
 *                      object store and nowhere else, so B's refs would point
 *                      at objects B does not hold. `fetch` does the same at
 *                      scale: it exited 0 and moved B's origin/main forward
 *                      while every object landed in A, leaving `cat-file -t
 *                      origin/main` in B failing with "could not get object
 *                      info". `clone` is the exception — it ignored the
 *                      variable and filled its own store. Inherited from a
 *                      pre-receive hook the named directory is the push
 *                      quarantine, which git deletes when the push ends, so the
 *                      fetched objects do not merely land in the wrong store,
 *                      they are thrown away and B is left with a ref to an
 *                      object nothing holds.
 * - GIT_ALTERNATE_OBJECT_DIRECTORIES
 *                      B read an object only A holds, so a fetch counts it as
 *                      already present and never transfers it: pointed at the
 *                      store B's own remote is served from, `fetch` exited 0
 *                      and created origin/main, and the same `cat-file -t`
 *                      failed once the variable was gone. That is the exact
 *                      shape a pre-receive hook hands over, its value being the
 *                      bare repository's own objects directory.
 * - GIT_NAMESPACE      `ls-remote` of a local remote listed none of its refs and
 *                      `fetch` transferred nothing, both exiting 0 — a remote
 *                      that silently reads as having no branches.
 * - GIT_CONFIG         `git config` read and wrote that one file instead of the
 *                      checkout's: the refspec convergence would read a foreign
 *                      file, write its narrowed refspec there, and leave the
 *                      checkout unconverged on every tick. git's own docs call
 *                      it "mostly for historical compatibility" and note it has
 *                      no effect on any other command, which is exactly what
 *                      makes it worse than useless here.
 *
 * Deliberately kept: GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM
 * / GIT_CONFIG_COUNT choose configuration *content* for whichever repository we
 * picked, never the repository (and the test suite pins the first two to isolate
 * itself from the host's git config). GIT_INDEX_VERSION, GIT_DEFAULT_HASH,
 * GIT_DEFAULT_REF_FORMAT and GIT_REFERENCE_BACKEND pick on-disk formats for new
 * repositories, not which repository. GIT_PREFIX and GIT_QUARANTINE_PATH are
 * also exported to hooks but changed nothing when inherited (measured: pathspecs
 * still resolved against the command's own directory, and `hash-object -w` still
 * wrote to the repository's own object store). Everything that authenticates or
 * finds git — PATH, HOME, SSH_AUTH_SOCK, GIT_ASKPASS, GIT_SSH_COMMAND,
 * GIT_PROXY_COMMAND, GIT_EXEC_PATH — is untouched.
 */
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

/**
 * A copy of `env` without any inherited repository-selection variable, so a git
 * command decides which repository it works on from the directory it runs in
 * and nothing else. Used for the git subprocesses this tool runs (through
 * sanitizeGitEnv) and for the user's `onBranchCreated` hook commands, which are
 * run with the new worktree as their working directory and would otherwise find
 * a different repository there.
 *
 * A variable passed deliberately survives: createGitClient merges its caller's
 * `extraEnv` after this, so only what the parent environment carried is dropped.
 */
export function stripGitRepositorySelection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = { ...env };
  for (const name of GIT_REPOSITORY_SELECTION_VARS) {
    delete stripped[name];
  }
  return stripped;
}

/**
 * The environment every git subprocess runs with. Starts from the parent
 * environment — simple-git's .env() REPLACES the child environment wholesale
 * (no merge with process.env), and a child without PATH/HOME/SSH_AUTH_SOCK
 * cannot authenticate or find git — and then:
 *
 * - drops every repository-selection variable (see
 *   GIT_REPOSITORY_SELECTION_VARS) so the `baseDir` a client was built with is
 *   what decides the repository;
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
 * The ssh command is deliberately left alone. git gives GIT_SSH_COMMAND
 * precedence over the `core.sshCommand` config key (verified on git 2.43: env +
 * config runs the env command; legacy GIT_SSH + config runs the config
 * command), so a "ssh -o BatchMode=yes" default injected here would silently
 * replace a user's configured ssh command — includeIf keys, `ssh -i work_key`,
 * agent wrappers. GIT_TERMINAL_PROMPT=0 covers git's own prompts only; ssh
 * reads a key passphrase or an unknown-host confirmation from /dev/tty itself,
 * and {@link sshNoPromptEnv} is what stops that for a repository reached over
 * ssh, through ssh's askpass variables rather than its command line.
 */
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

/** The values git's own boolean parsing reads as false for GIT_TERMINAL_PROMPT. */
const PROMPT_DISABLED_VALUES = new Set(["", "0", "false", "no", "off"]);

/** `ssh://...` or the scp shorthand `user@host:path` — the two ways a repoUrl reaches its remote over ssh. */
function usesSshTransport(repoUrl: string): boolean {
  return /^ssh:\/\//i.test(repoUrl) || parseGitUrl(repoUrl)?.kind === "scp";
}

/**
 * What a repository reached over ssh adds to its git clients' environment so
 * that ssh fails at once instead of waiting on a prompt nobody can answer: a
 * key passphrase without an agent, an unknown host key, a password or
 * keyboard-interactive login. `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+) makes
 * ssh ask the askpass program instead of the terminal, and `false` answers
 * every question with a failure — an empty passphrase, "no" to the host key —
 * so ssh ends with "Permission denied" or "Host key verification failed",
 * which the run reports with its usual hint. Older OpenSSH ignores the
 * variable and behaves as before.
 *
 * Neither variable touches the ssh command, so core.sshCommand, GIT_SSH_COMMAND
 * and GIT_SSH keep working exactly as configured. Nothing is added when:
 *
 * - the user exported SSH_ASKPASS or SSH_ASKPASS_REQUIRE — theirs wins;
 * - git prompts are enabled (GIT_TERMINAL_PROMPT exported as something other
 *   than false) — that user asked to be prompted, and ssh follows suit;
 * - the repository is not an ssh URL — git itself reads SSH_ASKPASS for HTTPS
 *   credentials, and would print an askpass error in front of its own
 *   "terminal prompts disabled" for a remote that is never reached over ssh;
 * - on Windows, where ssh's askpass resolution differs and nothing was verified.
 */
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
