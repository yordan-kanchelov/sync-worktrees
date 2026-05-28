---
"sync-worktrees": patch
---

Fix the landing-page hero headline clipping the descenders of its gradient line. The `bg-clip-text` line had an implicit `line-height: 1`, so the gradient box stopped at the baseline and characters like "y"/"g" were cut off; added line-height and bottom padding so descenders render fully.
