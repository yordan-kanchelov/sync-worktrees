// simple-git blocks EDITOR / GIT_EDITOR / GIT_SEQUENCE_EDITOR unless allowUnsafeEditor is set;
// strip them when forwarding process.env so a user's shell EDITOR doesn't break read-only commands.
// Every simple-git .env() call must spread this in: .env() REPLACES the child
// environment wholesale (no merge with process.env), and a child without
// PATH/HOME/SSH_AUTH_SOCK cannot authenticate or find git. Clients that pass
// an env this way also need the allowances in buildSimpleGitOptions /
// buildGitOptions: simple-git validates explicit env objects (GIT_ASKPASS,
// GIT_CONFIG_COUNT) while default clients inherit those same variables freely.
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.EDITOR;
  delete sanitized.GIT_EDITOR;
  delete sanitized.GIT_SEQUENCE_EDITOR;
  return sanitized;
}
