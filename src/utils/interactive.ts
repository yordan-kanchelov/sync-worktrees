import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";

import { extractRepoNameFromUrl } from "./git-url";

import type { InitConfigInput, InitRepositoryInput, RepositoryMode } from "../types";

function safeRepoName(repoUrl: string): string {
  try {
    return extractRepoNameFromUrl(repoUrl);
  } catch {
    return "";
  }
}

async function promptForRepository(): Promise<InitRepositoryInput> {
  const repoUrl = await input({
    message: "Enter the Git repository URL (e.g., https://github.com/user/repo.git):",
    validate: (value: string) => {
      if (!value.trim()) {
        return "Repository URL is required";
      }
      if (!value.match(/^(https?:\/\/|ssh:\/\/|git@|file:\/\/).*$/)) {
        return "Please enter a valid Git URL (https://, ssh://, git@, or file://)";
      }
      return true;
    },
  });

  const mode = (await select({
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
  })) as RepositoryMode;

  const repoName = safeRepoName(repoUrl);
  const defaultWorktreeDir = repoName ? `./${repoName}` : "";

  let worktreeDir = await input({
    message: mode === "clone" ? "Enter the directory to clone into:" : "Enter the directory for storing worktrees:",
    default: defaultWorktreeDir,
    validate: (value: string) => {
      if (!value.trim() && !defaultWorktreeDir) {
        return "Directory is required";
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

export async function promptForInitConfig(): Promise<InitConfigInput> {
  console.log("🔧 Welcome to sync-worktrees interactive setup!\n");

  const repositories: InitRepositoryInput[] = [];
  let addMore = true;
  while (addMore) {
    repositories.push(await promptForRepository());
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
      if (value.trim().split(/\s+/).length < 5) {
        return "Invalid cron pattern. Expected format: '* * * * *'";
      }
      return true;
    },
  });

  return { repositories, cronSchedule };
}
