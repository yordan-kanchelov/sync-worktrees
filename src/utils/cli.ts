import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import type { Config } from "../types";

export interface CliOptions extends Partial<Config> {
  config?: string;
  filter?: string;
  list?: boolean;
  bareRepoDir?: string;
  branchMaxAge?: string;
  skipLfs?: boolean;
  noUpdateExisting?: boolean;
}

export function parseArguments(): CliOptions {
  const argv = yargs(hideBin(process.argv))
    .option("config", {
      alias: "c",
      type: "string",
      description: "Path to JavaScript config file",
    })
    .option("filter", {
      alias: "f",
      type: "string",
      description: "Filter repositories by name (supports wildcards and comma-separated values)",
    })
    .option("list", {
      alias: "l",
      type: "boolean",
      description: "List configured repositories and exit",
      default: false,
    })
    .option("bareRepoDir", {
      alias: "b",
      type: "string",
      description: "Directory for storing bare repositories (default: .bare/<repo-name>).",
    })
    .option("repoUrl", {
      alias: "u",
      type: "string",
      description: "Git repository URL (e.g., SSH or HTTPS).",
    })
    .option("worktreeDir", {
      alias: "w",
      type: "string",
      description: "Absolute path to the directory for storing worktrees.",
    })
    .option("cronSchedule", {
      alias: "s",
      type: "string",
      description: "Cron schedule for how often to run the sync.",
      default: "0 * * * *",
    })
    .option("runOnce", {
      type: "boolean",
      description: "Run the sync process once and then exit, without scheduling.",
      default: false,
    })
    .option("branchMaxAge", {
      alias: "a",
      type: "string",
      description: "Maximum age of branches to sync (e.g., '30d', '6m', '1y').",
    })
    .option("skipLfs", {
      type: "boolean",
      description: "Skip Git LFS downloads when fetching and creating worktrees.",
      default: false,
    })
    .option("no-update-existing", {
      type: "boolean",
      description: "Disable automatic updates of existing worktrees.",
      default: false,
    })
    .help()
    .alias("help", "h")
    .parseSync();

  return {
    config: argv.config,
    filter: argv.filter,
    list: argv.list,
    repoUrl: argv.repoUrl,
    worktreeDir: argv.worktreeDir,
    cronSchedule: argv.cronSchedule,
    runOnce: argv.runOnce,
    bareRepoDir: argv.bareRepoDir,
    branchMaxAge: argv.branchMaxAge,
    skipLfs: argv.skipLfs,
    noUpdateExisting: argv["no-update-existing"] as boolean,
  };
}

export function isInteractiveMode(config: Partial<Config>): boolean {
  return !config.repoUrl || !config.worktreeDir;
}

export function reconstructCliCommand(config: Config): string {
  const executable = process.argv[1].includes("ts-node") ? "ts-node src/index.ts" : "sync-worktrees";

  const args: string[] = [];

  args.push(`--repoUrl "${config.repoUrl}"`);

  if (config.worktreeDir) {
    args.push(`--worktreeDir "${config.worktreeDir}"`);
  }

  if (config.bareRepoDir) {
    args.push(`--bareRepoDir "${config.bareRepoDir}"`);
  }

  if (config.cronSchedule && config.cronSchedule !== "0 * * * *") {
    args.push(`--cronSchedule "${config.cronSchedule}"`);
  }

  if (config.runOnce) {
    args.push("--runOnce");
  }

  if (config.branchMaxAge) {
    args.push(`--branchMaxAge "${config.branchMaxAge}"`);
  }

  if (config.skipLfs) {
    args.push("--skip-lfs");
  }

  if (config.updateExistingWorktrees === false) {
    args.push("--no-update-existing");
  }

  return `${executable} ${args.join(" ")}`;
}
