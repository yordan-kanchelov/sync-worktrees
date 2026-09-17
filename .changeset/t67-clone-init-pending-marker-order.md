---
"sync-worktrees": patch
---

Clone mode now writes the clone-init pending marker the moment `git clone` returns, before it narrows the new clone's remote. That marker is the only record that a finished clone still owes the initial `filesToCopyOnBranchCreate` copy — the existing-clone path runs the copy only for a clone carrying it — and it used to be written after the refspec narrowing, four or more git subprocesses later. A process killed in that window -- SIGKILL or an OOM kill; the marker is not fsynced, so a power loss is no better served than the clone's own writes are -- left a complete clone with no marker: the next run adopted it as one the user had made, re-ran the narrowing, and never copied the files, on that run or any later one, with nothing logged about it.

The window is narrower, not gone: `git clone` returning and the marker write are two operations and no ordering makes them one, so a kill between them still drops the copy. What is left is a single file write instead of the narrowing's git subprocesses.

Nothing else moves. The marker write stays best-effort (a failure warns and the init continues), the narrowing it now follows is idempotent and re-run whenever an interrupted init is resumed, and a clone whose checkout never finished is still refused by the separate `.git/.sync-worktrees-clone-incomplete` marker before the pending one is consulted at all.
