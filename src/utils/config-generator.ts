import * as fs from "fs/promises";
import * as path from "path";

import { CONFIG_FILE_NAMES } from "../constants";
import { ConfigFileExistsError } from "../errors";

import { fileExists } from "./file-exists";
import { extractRepoNameFromUrl } from "./git-url";

import type { InitConfigInput, InitRepositoryInput } from "../types";

export { ConfigFileExistsError };

const CONFIG_CHEATSHEET = `
// ─── More options (copy into a repository entry above) ────────────────
// worktree mode (default):
//   branchMaxAge: "14d",                    // ignore/remove branches older than N (d/h/w)
//   branchInclude: ["main", "release/*"],   // only sync matching branches
//   branchExclude: ["dependabot/*"],
//   sparseCheckout: { include: ["packages/app", "jenkins"] },
//   updateExistingWorktrees: true,          // fast-forward clean worktrees each sync
// clone mode ("mode": "clone"):
//   branch: "develop",                      // omit to track the remote default branch
//   depth: 10,                              // shallow clone; omit for full history
// any repo, or under "defaults":
//   debug: true,
//   parallelism: { maxRepositories: 3, maxWorktreeUpdates: 3 },
//   hooks: { onBranchCreated: ["<command>"] },  // see README for placeholders
// Full reference: https://github.com/yordan-kanchelov/sync-worktrees#configuration
`;

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

function toConfigRelativePath(configDir: string, target: string): string {
  const relative = path.relative(configDir, target);
  return relative.startsWith("../../../") ? target : `./${relative}`;
}

function buildRepository(repo: InitRepositoryInput, configDir: string): SerializableObject {
  const result: SerializableObject = {
    name: extractRepoNameFromUrl(repo.repoUrl),
    repoUrl: repo.repoUrl,
    worktreeDir: toConfigRelativePath(configDir, repo.worktreeDir),
  };

  if (repo.mode === "clone") {
    result.mode = "clone";
    if (repo.branch) {
      result.branch = repo.branch;
    }
    if (repo.depth !== undefined) {
      result.depth = repo.depth;
    }
  } else if (repo.bareRepoDir) {
    result.bareRepoDir = toConfigRelativePath(configDir, repo.bareRepoDir);
  }

  return result;
}

export async function generateConfigFile(
  input: InitConfigInput,
  configPath: string,
  options: GenerateConfigFileOptions = {},
): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  const configObject: SerializableObject = {
    defaults: {
      cronSchedule: input.cronSchedule,
    },
    repositories: input.repositories.map((repo) => buildRepository(repo, configDir)),
  };

  const configContent = `// @ts-check

/**
 * Sync-worktrees configuration file
 * Generated on ${new Date().toISOString()}
 */

/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
const config = ${serializeToESM(configObject)};

export default config;
${CONFIG_CHEATSHEET}`;

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
