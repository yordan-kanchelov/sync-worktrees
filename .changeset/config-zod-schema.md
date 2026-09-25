---
"sync-worktrees": minor
---

Config validation now reports every problem in the file at once, and names each setting by its path in the file and
the repository it belongs to, followed by the value it found:

```text
Invalid configuration for 'repositories[1].cronSchedule' (repository 'api'): '0 * *' is not a valid cron expression
Invalid configuration for 'defaults.retry.maxAttempts': must be 'unlimited' or a positive safe integer, got 0
```

Previously the load stopped at the first problem, and the messages came in several shapes ("Repository 'api' has
invalid cron expression", "Invalid 'maxAttempts' in retry config", ...). Every validation failure is now a
`ConfigValidationError`, so it is no longer prefixed with "Failed to load config file:".

The rules themselves are unchanged, with a few nonsensical shapes now refused instead of silently ignored: an array
where a block (`retry`, `hooks`, `trash`, ...) belongs, a `defaults` that is `false`, `0` or `""` (`null` still means
no defaults), a whitespace-only repository `name` or `worktreeDir`, and a non-string `defaults.repoUrl`,
`defaults.worktreeDir` or `defaults.bareRepoDir`. Unknown keys are still warnings with a "did you mean" suggestion.
