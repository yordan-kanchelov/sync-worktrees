import * as fs from "fs/promises";
import * as path from "path";

import { extractRepoNameFromUrl } from "./git-url";

import type { Config } from "../types";

type SerializableValue = string | number | boolean | null | undefined | SerializableObject | SerializableValue[];
interface SerializableObject {
  [key: string]: SerializableValue;
}

/**
 * Serializes a JavaScript object to a clean ESM export default format
 */
function serializeToESM(obj: SerializableValue, indent: number = 0): string {
  const spaces = " ".repeat(indent);
  const innerSpaces = " ".repeat(indent + 2);

  if (typeof obj === "string") {
    return `"${obj}"`;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    const items = obj.map((item) => `${innerSpaces}${serializeToESM(item, indent + 2)}`).join(",\n");
    return `[\n${items}\n${spaces}]`;
  }

  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => {
        const serializedValue = serializeToESM(value, indent + 2);
        return `${innerSpaces}${key}: ${serializedValue}`;
      });

    if (entries.length === 0) return "{}";
    return `{\n${entries.join(",\n")}\n${spaces}}`;
  }

  return String(obj);
}

export async function generateConfigFile(config: Config, configPath: string): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  // Calculate relative paths from config file location
  const worktreeDirRelative = path.relative(configDir, config.worktreeDir);
  const useRelativeWorktree = !worktreeDirRelative.startsWith("../../../");

  const repoName = extractRepoNameFromUrl(config.repoUrl);

  // Build the repository object
  const repository: SerializableObject = {
    name: repoName,
    repoUrl: config.repoUrl,
    worktreeDir: useRelativeWorktree ? `./${worktreeDirRelative}` : config.worktreeDir,
  };

  // Add bareRepoDir if provided
  if (config.bareRepoDir) {
    const bareRepoDirRelative = path.relative(configDir, config.bareRepoDir);
    const useRelativeBare = !bareRepoDirRelative.startsWith("../../../");
    repository.bareRepoDir = useRelativeBare ? `./${bareRepoDirRelative}` : config.bareRepoDir;
  }

  // Build the complete config object
  const configObject = {
    defaults: {
      cronSchedule: config.cronSchedule,
      runOnce: config.runOnce,
    },
    repositories: [repository],
  };

  // Generate the config file content
  const configContent = `/**
 * Sync-worktrees configuration file
 * Generated on ${new Date().toISOString()}
 */

export default ${serializeToESM(configObject)};
`;

  await fs.writeFile(configPath, configContent, "utf-8");
}

export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), "sync-worktrees.config.js");
}
