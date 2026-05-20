---
"sync-worktrees": patch
---

Push newly created branches to origin by default from `create_worktree`, keep `push=false` as an explicit opt-out, and prevent created branches from inheriting the base branch's upstream.
