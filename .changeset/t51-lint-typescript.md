---
"sync-worktrees": patch
---

`pnpm lint` now type-checks all TypeScript sources and tests with typescript-eslint (including `no-floating-promises` and `no-misused-promises`) and eslint-plugin-react-hooks, so the CI lint step covers the whole app instead of six root JavaScript files.
