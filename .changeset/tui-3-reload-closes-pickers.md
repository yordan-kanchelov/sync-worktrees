---
"sync-worktrees": patch
---

A config reload that reordered or replaced repositories without changing their count left an open picker (`o`, `c`, `w`, `/`) on the old list, so its next action could hit a different repository. A reload now closes any open picker.
