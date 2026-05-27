---
question: "Can I run it continuously or on a cron?"
order: 6
---

Yes. The default invocation launches the interactive TUI and syncs continuously based on the `cronSchedule` field in your config (per-repo overrides are supported). For one-shot or scripted use, pass `--runOnce`. For CI pipelines, point `--config` at your workspace config and the same one-shot path applies.
