---
"sync-worktrees": major
---

**Breaking: the MCP server no longer reads the `SYNC_WORKTREES_CONFIG` environment variable.** Auto-detect is now the only way a config reaches the server at startup: it walks up from the client's working directory and loads the first `sync-worktrees.config.{js,mjs,cjs,ts}` it finds, which is exactly what it already did whenever the variable was unset. A config the walk-up cannot reach is loaded at runtime with `load_config {configPath}`, as before.

**If your MCP client config sets `SYNC_WORKTREES_CONFIG`:** remove the `env` entry (or the `-e` flag on `claude mcp add`). When the config file sits in the client's working directory or one of its parents, nothing else changes. When it lives elsewhere, call `load_config` with its path once per server session; until then `sync` and `initialize` report the repository as unconfigured, as they always have without a loaded config.

**Why major.** The README's standard config block told every client to set the variable, so installs that followed it exist, and after this change the setting is ignored without a warning. For a config outside the walk-up path, `sync` and `initialize` go from available at startup to unavailable. Withdrawing a documented setting that working installs rely on is what a major is for, so this releases as 7.0.0 rather than 6.1.0.

**What moved with it.** The `load_config` tool description and its `configPath` fallback chain (explicit path, then an already detected config, then a launch-CWD walk-up), the "no repository selected" recovery hint, the README's Getting started section and the site's client hints no longer name the variable. The server now logs `Auto-loaded config: <path>` to stderr at startup in place of the old `Loaded config:` line, so whoever is tailing it still sees which file was picked up.
