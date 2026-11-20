import * as fs from "fs/promises";
import * as path from "path";

import { ConfigFileExistsError } from "../errors";

import { extractRepoNameFromUrl } from "./git-url";

import type { InitConfigInput, InitRepositoryInput } from "../types";

const CONFIG_CHEATSHEET = `
// ─── More options (copy into a repository entry above) ────────────────
// worktree mode (default):
//   branchMaxAge: "14d",                    // ignore/remove branches older than N (h/d/w/m/y)
//   branchInclude: ["main", "release/*"],   // only sync matching branches
//   branchExclude: ["dependabot/*"],
//   sparseCheckout: { include: ["packages/app", "jenkins"] },
//   updateExistingWorktrees: true,          // fast-forward clean worktrees each sync
// clone mode ("mode": "clone"):
//   branch: "develop",                      // omit to track the remote default branch
//   depth: 10,                              // shallow clone; omit for full history
// any repo, or under "defaults":
//   debug: true,
//   parallelism: { maxWorktreeUpdates: 3 },   // maxRepositories only at top level or in "defaults"
//   hooks: { onBranchCreated: ["<command>"] },  // placeholders: docs/hooks-and-file-copying.md
// Full reference: https://github.com/yordan-kanchelov/sync-worktrees#configuration
`;

type SerializableValue = string | number | boolean | null | undefined | SerializableObject | SerializableValue[];
interface SerializableObject {
  [key: string]: SerializableValue;
}

function serializeValue(obj: SerializableValue, indent: number = 0): string {
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
    const items = obj.map((item) => `${innerSpaces}${serializeValue(item, indent + 2)}`).join(",\n");
    return `[\n${items}\n${spaces}]`;
  }

  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => {
        const serializedValue = serializeValue(value, indent + 2);
        return `${innerSpaces}${key}: ${serializedValue}`;
      });

    if (entries.length === 0) return "{}";
    return `{\n${entries.join(",\n")}\n${spaces}}`;
  }

  return String(obj);
}

type ConfigModuleSystem = "esm" | "cjs";

async function readNearestPackageType(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(path.join(current, "package.json"), "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") {
        return undefined;
      }
    }

    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        const type = (parsed as { type?: unknown } | null)?.type;
        return typeof type === "string" ? type : undefined;
      } catch {
        return undefined;
      }
    }

    if (current === root) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function detectConfigModuleSystem(configPath: string): Promise<ConfigModuleSystem> {
  const extension = path.extname(configPath);
  if (extension === ".cjs") return "cjs";
  if (extension === ".mjs") return "esm";
  return (await readNearestPackageType(path.dirname(configPath))) === "commonjs" ? "cjs" : "esm";
}

export interface GenerateConfigFileOptions {
  overwrite?: boolean;
}

function toConfigRelativePath(configDir: string, target: string): string {
  const relative = path.relative(configDir, target);
  const segments = relative.split(path.sep);
  const upLevels = segments.filter((segment) => segment === "..").length;
  if (upLevels > 2) {
    return target;
  }
  return segments[0] === ".." ? relative : `./${relative}`;
}

function buildRepository(repo: InitRepositoryInput, configDir: string, name: string): SerializableObject {
  const result: SerializableObject = {
    name,
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

function uniqueRepositoryNames(repositories: InitRepositoryInput[]): string[] {
  const usedNames = new Set<string>();

  return repositories.map((repo) => {
    const baseName = extractRepoNameFromUrl(repo.repoUrl);
    let candidate = baseName;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${baseName}-${suffix}`;
      suffix++;
    }
    usedNames.add(candidate);
    return candidate;
  });
}

export async function generateConfigFile(
  input: InitConfigInput,
  configPath: string,
  options: GenerateConfigFileOptions = {},
): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  const names = uniqueRepositoryNames(input.repositories);
  const configObject: SerializableObject = {
    defaults: {
      cronSchedule: input.cronSchedule,
    },
    repositories: input.repositories.map((repo, index) => buildRepository(repo, configDir, names[index])),
  };

  const moduleSystem = await detectConfigModuleSystem(configPath);
  const exportStatement = moduleSystem === "cjs" ? "module.exports = config;" : "export default config;";

  const configContent = `// @ts-check

/**
 * Sync-worktrees configuration file
 * Generated on ${new Date().toISOString()}
 */

/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
const config = ${serializeValue(configObject)};

${exportStatement}
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
