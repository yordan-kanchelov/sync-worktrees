---
"sync-worktrees": patch
---

`hooks.onBranchCreated` commands used to start all at once, so `["pnpm install", "pnpm build"]` raced, and their output could arrive with split characters and no command name. They now run one at a time in array order, stopping at the first failure (the rest are logged as skipped), and each output line is decoded whole and prefixed with its command.
