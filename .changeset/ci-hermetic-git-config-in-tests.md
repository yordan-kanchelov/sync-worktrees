---
"sync-worktrees": patch
---

Test-suite only: every git the suite runs now sees an empty global config and no system config. The LFS suites stand in for a broken LFS setup by installing a deliberately failing `filter.lfs.smudge`, but `git lfs install` defines `filter.lfs.process`, and git prefers a long-running process filter over `smudge`/`clean` without ever falling back to them. On any machine that has git-lfs — every GitHub Actions runner — the failing smudge was shadowed, the checkout succeeded, and the assertions that expect a failure inverted, so the suite passed locally and failed in CI. Pinning the configuration also stops any other host setting from reaching the tests.
