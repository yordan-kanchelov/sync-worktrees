---
"sync-worktrees": minor
---

Add config file support for managing multiple repositories

- Added support for JavaScript configuration files to manage multiple repositories with different settings
- New CLI options: `--config` to specify config file, `--filter` to select specific repositories, and `--list` to show configured repositories
- Interactive mode now prompts users to save their configuration to a file for future use
- When specifying a non-existent config file, users are prompted to create one through interactive setup
- Config files support environment variables, dynamic paths, and can use relative paths
- Added comprehensive validation for config files with helpful error messages
- Maintains full backward compatibility - existing single-repository CLI usage continues to work

Example config file:
```javascript
module.exports = {
  defaults: {
    cronSchedule: "0 * * * *",
    runOnce: false
  },
  repositories: [
    {
      name: "my-project",
      repoUrl: "https://github.com/user/repo.git",
      repoPath: "./repos/my-project",
      worktreeDir: "./worktrees/my-project"
    }
  ]
};
```