---
question: "Is it safe with uncommitted work?"
order: 1
---

Yes: uncommitted and untracked work is never touched. A clean tree with nothing unpushed can fast-forward. Committed work that has drifted from upstream is set aside, not silently overwritten; [force-push or deleted upstream](/faq/force-push-delete/) covers that case. If you keep your own folders in the workspace, leave recovery on.
