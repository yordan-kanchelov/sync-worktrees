import * as fs from "fs/promises";
import * as path from "path";

import type { Config } from "../types";

export async function generateConfigFile(config: Config, configPath: string): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  // Calculate relative paths from config file location
  const repoPathRelative = path.relative(configDir, config.repoPath);
  const worktreeDirRelative = path.relative(configDir, config.worktreeDir);

  // Use relative paths if they don't go up too many levels
  const useRelativeRepo = !repoPathRelative.startsWith("../../../");
  const useRelativeWorktree = !worktreeDirRelative.startsWith("../../../");

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
      name: "${path.basename(config.repoPath)}",
      ${config.repoUrl ? `repoUrl: "${config.repoUrl}",\n      ` : ""}repoPath: "${useRelativeRepo ? `./${repoPathRelative}` : config.repoPath}",
      worktreeDir: "${useRelativeWorktree ? `./${worktreeDirRelative}` : config.worktreeDir}"
    }
  ]
};
`;

  await fs.writeFile(configPath, configContent, "utf-8");
}

export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), "sync-worktrees.config.js");
}
