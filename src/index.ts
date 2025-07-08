#!/usr/bin/env node

import * as path from "path";

import * as cron from "node-cron";

import { WorktreeSyncService } from "./services/worktree-sync.service";
import { isInteractiveMode, parseArguments, reconstructCliCommand } from "./utils/cli";
import { promptForConfig } from "./utils/interactive";

import type { Config } from "./types";

async function main(): Promise<void> {
  const partialConfig = parseArguments();

  let config: Config;
  if (isInteractiveMode(partialConfig)) {
    config = await promptForConfig(partialConfig);
  } else {
    config = partialConfig as Config;
  }

  console.log("\n📋 CLI Command (for future reference):");
  console.log(`   ${reconstructCliCommand(config)}`);
  console.log("");

  const syncService = new WorktreeSyncService(config);

  try {
    await syncService.initialize();

    if (config.runOnce) {
      console.log("Running the sync process once as requested by --runOnce flag.");
      await syncService.sync();
    } else {
      console.log("Git Worktree Sync script started as a scheduled job.");
      console.log(`Job is scheduled with cron pattern: "${config.cronSchedule}"`);
      console.log(`To see options, run: node ${path.basename(process.argv[1])} --help`);

      console.log("Running initial sync...");
      await syncService.sync();

      console.log("Waiting for the next scheduled run...");

      cron.schedule(config.cronSchedule, async () => {
        try {
          await syncService.sync();
        } catch (error) {
          console.error("Error during scheduled sync:", error);
        }
      });
    }
  } catch (error) {
    console.error("❌ Fatal Error during initialization:", (error as Error).message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});
