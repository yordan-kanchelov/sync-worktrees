---
"sync-worktrees": patch
---

Pasting text that ends in a newline (such as a copied branch name) into the branch, open or status filter no longer stores the newline, which made the filter show "No matches"; line breaks are now dropped and the pasted text is trimmed.
