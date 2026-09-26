---
"sync-worktrees": patch
---

A remote reached over ssh no longer blocks a sync on a prompt nobody can answer: its git runs with `SSH_ASKPASS_REQUIRE=force` and `SSH_ASKPASS=false`, so with OpenSSH 8.4 or later a passphrase-protected key without an agent, or a host missing from `known_hosts`, fails at once with the usual hint instead of waiting for the 300-second inactivity timeout. Your ssh command (`core.sshCommand`, `GIT_SSH_COMMAND`) is never changed, and nothing is set when you exported `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE` or a `GIT_TERMINAL_PROMPT` that enables prompts.

A config reload (`r` in the dashboard, `load_config` over MCP) that has not finished evaluating the config after 30 seconds is stopped and reported, and the loaded config stays in effect; before, it hung for good.

A repository configured without a `name` is labelled by its redacted URL everywhere, including the dashboard's progress rows during a reload and `SYNC_WORKTREES_REPO_NAME` for `onBranchCreated` hooks; every string sent to the dashboard is now redacted on the way in.

A failed clone no longer deletes a destination directory another process created between the tool's check and its own `mkdir`, and it now also removes the empty parent directories it created for the destination.
