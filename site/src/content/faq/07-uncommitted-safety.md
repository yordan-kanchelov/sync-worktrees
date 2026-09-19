---
question: "Is it safe with uncommitted work?"
order: 1
---

Yes: dirty and untracked work is never touched. A clean tree with nothing unpushed can fast-forward. Diverged committed work goes to `.trash/`, not a silent overwrite; [force-push or deleted upstream](/faq/force-push-delete/) covers that case. Keep trash on if you also leave random dirs in the workspace.
