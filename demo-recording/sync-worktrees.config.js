// Fixture config for the README demo GIF.
// Two repositories: one in worktree mode (github/gitignore — small, ~30 branches),
// one in clone mode (octocat/Hello-World — small, fixed-path checkout).

export default {
  defaults: {
    runOnce: false,
    cronSchedule: "0 * * * *",
  },
  repositories: [
    {
      name: "gitignore",
      repoUrl: "https://github.com/github/gitignore.git",
      worktreeDir: "./fixture/gitignore-worktrees",
      bareRepoDir: "./fixture/.bare/gitignore",
      branchInclude: ["main", "master", "feature/*", "release/*"],
    },
    {
      name: "hello-world",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "./fixture/hello-world",
      mode: "clone",
      branch: "master",
      depth: 1,
    },
  ],
};
