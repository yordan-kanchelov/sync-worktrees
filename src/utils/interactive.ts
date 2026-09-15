import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";
import * as cron from "node-cron";

import { extractRepoNameFromUrl } from "./git-url";
import { pathsEqual } from "./path-compare";

import type { InitConfigInput, InitRepositoryInput } from "../types";

function safeRepoName(repoUrl: string): string {
  try {
    return extractRepoNameFromUrl(repoUrl);
  } catch {
    return "";
  }
}

async function promptForRepository(configDir: string): Promise<InitRepositoryInput> {
  const repoUrl = await input({
    message: "Enter the Git repository URL (e.g., https://github.com/user/repo.git):",
    validate: (value: string) => {
      if (!value.trim()) {
        return "Repository URL is required";
      }
      if (!value.match(/^(https?:\/\/|ssh:\/\/|git@|file:\/\/).*$/)) {
        return "Please enter a valid Git URL (https://, ssh://, git@, or file://)";
      }
      if (!safeRepoName(value)) {
        return "Couldn't derive a repository name from that URL — include the full path (e.g., https://github.com/user/repo.git)";
      }
      return true;
    },
  });

  const mode = await select({
    message: "How should this repository be managed?",
    choices: [
      {
        name: "worktree — bare repo + one worktree per remote branch (default)",
        value: "worktree",
      },
      {
        name: "clone — a single standalone checkout (for fixed-path monorepo siblings)",
        value: "clone",
      },
    ],
  });

  const repoName = safeRepoName(repoUrl);
  const defaultWorktreeDir = repoName ? `./${repoName}` : "";

  let worktreeDir = await input({
    message: mode === "clone" ? "Enter the directory to clone into:" : "Enter the directory for storing worktrees:",
    default: defaultWorktreeDir,
    validate: (value: string) => {
      if (!value.trim() && !defaultWorktreeDir) {
        return "Directory is required";
      }
      // The config's own directory is never a usable worktreeDir: the generator
      // would write `worktreeDir: "./"`, and the default bareRepoDir — `.bare/<name>`
      // resolved against the *config file's* directory, not against worktreeDir —
      // would land inside it, so the very next run would be rejected by the
      // bareRepoDir/worktreeDir overlap check.
      if (mode !== "clone" && pathsEqual(path.resolve(value.trim() || defaultWorktreeDir), configDir)) {
        return (
          `That is the config file's own directory. The bare repository defaults to '.bare/<name>' beside the ` +
          `config file, so it would land inside worktreeDir and the config would be rejected as overlapping. ` +
          `Use a subdirectory such as ${defaultWorktreeDir || "./worktrees"}.`
        );
      }
      return true;
    },
  });

  if (!worktreeDir.trim() && defaultWorktreeDir) {
    worktreeDir = defaultWorktreeDir;
  }
  if (!path.isAbsolute(worktreeDir)) {
    worktreeDir = path.resolve(worktreeDir);
  }

  // Clone mode is a warning, not a reject: `git clone` refuses a non-empty
  // destination, and the directory holding the config file is never empty.
  if (mode === "clone" && pathsEqual(worktreeDir, configDir)) {
    console.warn(
      `\n⚠️  '${worktreeDir}' is the config file's own directory. 'git clone' refuses a destination that exists and ` +
        `is not empty, so the first sync will fail with "Cannot clone into '${worktreeDir}': directory exists and ` +
        `is not empty." unless you move the config elsewhere.\n`,
    );
  }

  const repo: InitRepositoryInput = { repoUrl, worktreeDir, mode };

  if (mode === "worktree") {
    const askForBareDir = await confirm({
      message: "Would you like to specify a custom location for the bare repository?",
      default: false,
    });
    if (askForBareDir) {
      let bareRepoDir = await input({
        message: "Enter the directory for the bare repository:",
        validate: (value: string) => (value.trim() ? true : "Bare repository directory is required"),
      });
      if (!path.isAbsolute(bareRepoDir)) {
        bareRepoDir = path.resolve(bareRepoDir);
      }
      repo.bareRepoDir = bareRepoDir;
    }
  } else {
    const branch = await input({
      message: "Branch to clone (leave blank to track the remote default branch):",
      default: "",
    });
    if (branch.trim()) {
      repo.branch = branch.trim();
    }

    const depthAnswer = await input({
      message: "Shallow clone depth (leave blank for full history):",
      default: "",
      validate: (value: string) => {
        if (!value.trim()) {
          return true;
        }
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? true : "Depth must be a positive integer";
      },
    });
    if (depthAnswer.trim()) {
      repo.depth = Number(depthAnswer);
    }
  }

  return repo;
}

/**
 * @param configDir Directory the generated config file will live in. Answers
 *   equal to it are rejected (worktree mode) or warned about (clone mode).
 */
export async function promptForInitConfig(configDir: string): Promise<InitConfigInput> {
  console.log("🔧 Welcome to sync-worktrees interactive setup!\n");

  const resolvedConfigDir = path.resolve(configDir);
  const repositories: InitRepositoryInput[] = [];
  let addMore = true;
  while (addMore) {
    repositories.push(await promptForRepository(resolvedConfigDir));
    addMore = await confirm({
      message: "Add another repository?",
      default: false,
    });
  }

  const cronSchedule = await input({
    message: "Enter the cron schedule for syncing (or press enter for default):",
    default: "0 * * * *",
    validate: (value: string) => {
      if (!value.trim()) {
        return "Cron schedule is required";
      }
      if (!cron.validate(value.trim())) {
        return "Invalid cron pattern. Expected format: '* * * * *'";
      }
      return true;
    },
  });

  return { repositories, cronSchedule };
}
