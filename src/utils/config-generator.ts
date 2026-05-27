import * as fs from "fs/promises";
import * as path from "path";

import { CONFIG_FILE_NAMES } from "../constants";
import { ConfigFileExistsError } from "../errors";

import { fileExists } from "./file-exists";
import { extractRepoNameFromUrl } from "./git-url";

import type { InitConfigInput } from "../types";

export { ConfigFileExistsError };

type SerializableValue = string | number | boolean | null | undefined | SerializableObject | SerializableValue[];
interface SerializableObject {
  [key: string]: SerializableValue;
}

function serializeToESM(obj: SerializableValue, indent: number = 0): string {
  const spaces = " ".repeat(indent);
  const innerSpaces = " ".repeat(indent + 2);

  if (typeof obj === "string") {
    return JSON.stringify(obj);
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

export interface GenerateConfigFileOptions {
  overwrite?: boolean;
}

export async function generateConfigFile(
  input: InitConfigInput,
  configPath: string,
  options: GenerateConfigFileOptions = {},
): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  const worktreeDirRelative = path.relative(configDir, input.worktreeDir);
  const useRelativeWorktree = !worktreeDirRelative.startsWith("../../../");

  const repoName = extractRepoNameFromUrl(input.repoUrl);

  const repository: SerializableObject = {
    name: repoName,
    repoUrl: input.repoUrl,
    worktreeDir: useRelativeWorktree ? `./${worktreeDirRelative}` : input.worktreeDir,
  };

  if (input.bareRepoDir) {
    const bareRepoDirRelative = path.relative(configDir, input.bareRepoDir);
    const useRelativeBare = !bareRepoDirRelative.startsWith("../../../");
    repository.bareRepoDir = useRelativeBare ? `./${bareRepoDirRelative}` : input.bareRepoDir;
  }

  const defaults: SerializableObject = {
    cronSchedule: input.cronSchedule,
  };
  if (input.runOnce) {
    defaults.runOnce = input.runOnce;
  }

  const configObject: SerializableObject = {
    defaults,
    repositories: [repository],
  };

  const configContent = `// @ts-check

/**
 * Sync-worktrees configuration file
 * Generated on ${new Date().toISOString()}
 */

/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
const config = ${serializeToESM(configObject)};

export default config;
`;

  try {
    await fs.writeFile(configPath, configContent, {
      encoding: "utf-8",
      flag: options.overwrite ? "w" : "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigFileExistsError(configPath);
    }
    throw error;
  }
}

export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), "sync-worktrees.config.js");
}

export async function findConfigInCwd(cwd: string = process.cwd()): Promise<string | null> {
  for (const name of CONFIG_FILE_NAMES) {
    const full = path.join(cwd, name);
    if (await fileExists(full)) {
      return full;
    }
  }
  return null;
}
