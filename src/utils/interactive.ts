import * as path from "path";

import { confirm, input, select } from "@inquirer/prompts";

import { generateConfigFile, getDefaultConfigPath } from "./config-generator";

import type { Config } from "../types";

export async function promptForConfig(partialConfig: Partial<Config>): Promise<Config> {
  console.log("🔧 Welcome to sync-worktrees interactive setup!\n");

  let repoUrl = partialConfig.repoUrl;
  if (!repoUrl) {
    repoUrl = await input({
      message: "Enter the Git repository URL (e.g., https://github.com/user/repo.git):",
      validate: (value: string) => {
        if (!value.trim()) {
          return "Repository URL is required";
        }
        try {
          // Basic URL validation
          if (!value.match(/^(https?:\/\/|git@|file:\/\/).*$/)) {
            return "Please enter a valid Git URL (https://, git@, or file://)";
          }
          return true;
        } catch {
          return "Please enter a valid URL";
        }
      },
    });
  }

  let worktreeDir = partialConfig.worktreeDir;
  if (!worktreeDir) {
    worktreeDir = await input({
      message: "Enter the directory for storing worktrees:",
      validate: (value: string) => {
        if (!value.trim()) {
          return "Worktree directory is required";
        }
        return true;
      },
    });
    if (!path.isAbsolute(worktreeDir)) {
      worktreeDir = path.resolve(worktreeDir);
    }
  }

  let bareRepoDir = partialConfig.bareRepoDir;
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

  let runOnce = partialConfig.runOnce;
  let cronSchedule = partialConfig.cronSchedule || "0 * * * *";

  if (runOnce === undefined) {
    const runMode = await select({
      message: "How would you like to run the sync?",
      choices: [
        { name: "Run once", value: "once" },
        { name: "Schedule with cron", value: "scheduled" },
      ],
    });
    runOnce = runMode === "once";

    if (!runOnce && !partialConfig.cronSchedule) {
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
  }

  const finalConfig: Config = {
    repoUrl,
    worktreeDir,
    cronSchedule,
    runOnce: runOnce || false,
    bareRepoDir,
  };

  console.log("\n📋 Configuration summary:");
  console.log(`   Repository URL: ${finalConfig.repoUrl}`);
  console.log(`   Worktrees:      ${finalConfig.worktreeDir}`);
  if (finalConfig.bareRepoDir) {
    console.log(`   Bare repo:      ${finalConfig.bareRepoDir}`);
  } else {
    console.log(`   Bare repo:      .bare/<repo-name> (default)`);
  }
  if (finalConfig.runOnce) {
    console.log(`   Mode:           Run once`);
  } else {
    console.log(`   Mode:           Scheduled (${finalConfig.cronSchedule})`);
  }
  console.log("");

  // Ask if user wants to save configuration to a file
  const saveConfig = await confirm({
    message: "Would you like to save this configuration to a file for future use?",
    default: true,
  });

  if (saveConfig) {
    const defaultConfigPath = getDefaultConfigPath();
    let configPath = await input({
      message: "Enter the path for the config file:",
      default: defaultConfigPath,
      validate: (value: string) => {
        if (!value.trim()) {
          return "Config file path is required";
        }
        if (!value.endsWith(".js")) {
          return "Config file must have a .js extension";
        }
        return true;
      },
    });

    if (!path.isAbsolute(configPath)) {
      configPath = path.resolve(configPath);
    }

    try {
      await generateConfigFile(finalConfig, configPath);
      console.log(`\n✅ Configuration saved to: ${configPath}`);
      console.log(`\n💡 You can now use this config file with:`);
      console.log(`   sync-worktrees --config ${path.relative(process.cwd(), configPath)}`);
      console.log("");
    } catch (error) {
      console.error(`\n❌ Failed to save config file: ${(error as Error).message}`);
    }
  }

  return finalConfig;
}
