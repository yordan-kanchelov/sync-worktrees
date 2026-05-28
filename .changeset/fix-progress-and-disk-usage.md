---
"sync-worktrees": patch
---

Tidy interactive UI progress and disk usage reporting: drop the StatusBar progress percent suffix that never fired (every git progress message already embeds its percentage) and relied on a fragile substring check, and mark repository disk-usage totals as approximate (`~`) when only some size paths fail instead of showing a confident undercount.
