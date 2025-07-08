import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import type { Config } from "../types";

export function parseArguments(): Partial<Config> {
  const argv = yargs(hideBin(process.argv))
    .option("repoPath", {
      alias: "r",
      type: "string",
      description: "Absolute path to the target local repository directory.",
    })
    .option("repoUrl", {
      alias: "u",
      type: "string",
      description: "Git repository URL (e.g., SSH or HTTPS). Used to clone if repoPath does not exist.",
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
    .help()
    .alias("help", "h")
    .parseSync();

  return {
    repoPath: argv.repoPath,
    repoUrl: argv.repoUrl,
    worktreeDir: argv.worktreeDir,
    cronSchedule: argv.cronSchedule,
    runOnce: argv.runOnce,
  };
}

export function isInteractiveMode(config: Partial<Config>): boolean {
  return !config.repoPath || !config.worktreeDir;
}

export function reconstructCliCommand(config: Config): string {
  const executable = process.argv[1].includes("ts-node") ? "ts-node src/index.ts" : "sync-worktrees";

  const args: string[] = [];

  if (config.repoPath) {
    args.push(`--repoPath "${config.repoPath}"`);
  }

  if (config.repoUrl) {
    args.push(`--repoUrl "${config.repoUrl}"`);
  }

  if (config.worktreeDir) {
    args.push(`--worktreeDir "${config.worktreeDir}"`);
  }

  if (config.cronSchedule && config.cronSchedule !== "0 * * * *") {
    args.push(`--cronSchedule "${config.cronSchedule}"`);
  }

  if (config.runOnce) {
    args.push("--runOnce");
  }

  return `${executable} ${args.join(" ")}`;
}
