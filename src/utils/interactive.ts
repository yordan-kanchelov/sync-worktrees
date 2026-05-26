import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";

import { extractRepoNameFromUrl } from "./git-url";

import type { InitConfigInput } from "../types";

export async function promptForInitConfig(): Promise<InitConfigInput> {
  console.log("🔧 Welcome to sync-worktrees interactive setup!\n");

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

  const repoName = extractRepoNameFromUrl(repoUrl);
  const defaultWorktreeDir = repoName ? `./${repoName}` : "";

  let worktreeDir = await input({
    message: "Enter the directory for storing worktrees:",
    default: defaultWorktreeDir,
    validate: (value: string) => {
      if (!value.trim() && !defaultWorktreeDir) {
        return "Worktree directory is required";
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

  let bareRepoDir: string | undefined;
  const askForBareDir = await confirm({
    message: "Would you like to specify a custom location for the bare repository?",
    default: false,
  });

  if (askForBareDir) {
    bareRepoDir = await input({
      message: "Enter the directory for the bare repository:",
      default: "",
      validate: (value: string) => {
        if (!value.trim()) {
          return "Bare repository directory is required";
        }
        return true;
      },
    });
    if (!path.isAbsolute(bareRepoDir)) {
      bareRepoDir = path.resolve(bareRepoDir);
    }
  }

  const runMode = await select({
    message: "How would you like to run the sync?",
    choices: [
      { name: "Run once", value: "once" },
      { name: "Schedule with cron", value: "scheduled" },
    ],
  });
  const runOnce = runMode === "once";

  let cronSchedule = "0 * * * *";
  if (!runOnce) {
    cronSchedule = await input({
      message: "Enter the cron schedule (or press enter for default):",
      default: "0 * * * *",
      validate: (value: string) => {
        if (!value.trim()) {
          return "Cron schedule is required";
        }
        const parts = value.trim().split(" ");
        if (parts.length < 5) {
          return "Invalid cron pattern. Expected format: '* * * * *'";
        }
        return true;
      },
    });
  }

  return {
    repoUrl,
    worktreeDir,
    bareRepoDir,
    cronSchedule,
    runOnce,
  };
}
