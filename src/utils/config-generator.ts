import * as fs from "fs/promises";
import * as path from "path";

import { extractRepoNameFromUrl } from "./git-url";

import type { Config } from "../types";

export async function generateConfigFile(config: Config, configPath: string): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  // Calculate relative paths from config file location
  const worktreeDirRelative = path.relative(configDir, config.worktreeDir);
  const useRelativeWorktree = !worktreeDirRelative.startsWith("../../../");

  let bareRepoDirEntry = "";
  if (config.bareRepoDir) {
    const bareRepoDirRelative = path.relative(configDir, config.bareRepoDir);
    const useRelativeBare = !bareRepoDirRelative.startsWith("../../../");
    bareRepoDirEntry = `,\n      bareRepoDir: "${useRelativeBare ? `./${bareRepoDirRelative}` : config.bareRepoDir}"`;
  }

  const repoName = extractRepoNameFromUrl(config.repoUrl);
  const worktreeDirEntry = `worktreeDir: "${useRelativeWorktree ? `./${worktreeDirRelative}` : config.worktreeDir}"`;

  const configContent = `/**
 * Sync-worktrees configuration file
 * Generated on ${new Date().toISOString()}
 */

module.exports = {
  defaults: {
    cronSchedule: "${config.cronSchedule}",
    runOnce: ${config.runOnce}
  },

  repositories: [
    {
      name: "${repoName}",
      repoUrl: "${config.repoUrl}",
      ${worktreeDirEntry}${bareRepoDirEntry}
    }
  ]
};
`;

  await fs.writeFile(configPath, configContent, "utf-8");
}

export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), "sync-worktrees.config.js");
}
