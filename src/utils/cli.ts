import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import type { Config } from "../types";

export function parseArguments(): Config {
  return yargs(hideBin(process.argv))
    .option("repoPath", {
      alias: "r",
      type: "string",
      description: "Absolute path to the target local repository directory.",
      demandOption: true,
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
      demandOption: true,
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
    .parseSync() as Config;
}
