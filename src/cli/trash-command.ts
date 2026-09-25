import * as path from "path";

import { input } from "@inquirer/prompts";
import Table from "cli-table3";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { SyncWorktreesError } from "../errors";
import { ConfigLoaderService } from "../services/config-loader.service";
import { isWorktreeRestorable } from "../services/trash.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";
import { formatBytes } from "../utils/disk-space";
import { configLoadErrorMessage } from "../utils/errors";
import { redactSecretsInText } from "../utils/git-url";

import type { TrashEntry, TrashManifest } from "../services/trash.service";
import type { Argv } from "yargs";

/** What one `sync-worktrees trash` invocation asks for. */
export type TrashAction =
  | { kind: "list"; json: boolean }
  | { kind: "restore"; id: string }
  | { kind: "purge"; id: string }
  | { kind: "purge-all" }
  | { kind: "drop-keep-ref"; name: string }
  | { kind: "drop-all-keep-refs" };

/** Everything `sync-worktrees trash` accepts beyond `--config`. */
export interface TrashCliOptions {
  filter?: string;
  action: TrashAction;
  /** Wait for a repository lock another process holds; only restore and purge take one. */
  wait: boolean;
  /**
   * The pre-subcommand flag the action was spelled with (`--restore`), when it
   * was. Those spellings keep working so scripts do not break, and name their
   * replacement once per run.
   */
  deprecatedFlag?: LegacyTrashFlag;
}

export type TrashCommandOptions = TrashCliOptions & { config?: string };

/** The subcommands of `trash`, for "did you mean" hints. */
export const TRASH_SUBCOMMAND_NAMES = ["list", "restore", "purge", "drop-keep-ref", "drop-all-keep-refs"] as const;

/** The flags that selected an action before `trash` had subcommands, and the subcommand each one became. */
const LEGACY_FLAGS = {
  "--restore": "trash restore <id>",
  "--purge": "trash purge <id>",
  "--drop-keep-ref": "trash drop-keep-ref <name>",
  "--drop-all-keep-refs": "trash drop-all-keep-refs",
} as const;

type LegacyTrashFlag = keyof typeof LEGACY_FLAGS;

/** Every long flag `trash` and its subcommands accept, for "did you mean" hints. */
export const TRASH_FLAG_NAMES = [
  "all",
  "json",
  "wait",
  "restore",
  "purge",
  "drop-keep-ref",
  "drop-all-keep-refs",
] as const;

interface LegacyTrashArgs {
  restore?: string;
  purge?: string;
  dropKeepRef?: string;
  dropAllKeepRefs: boolean;
}

type RawArgs = Record<string, unknown>;

function stringArg(args: RawArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function legacyArgs(args: RawArgs): LegacyTrashArgs {
  return {
    restore: stringArg(args, "restore"),
    purge: stringArg(args, "purge"),
    dropKeepRef: stringArg(args, "dropKeepRef"),
    dropAllKeepRefs: args.dropAllKeepRefs === true,
  };
}

function legacyFlagsIn(args: LegacyTrashArgs): LegacyTrashFlag[] {
  const used: LegacyTrashFlag[] = [];
  if (args.restore !== undefined) used.push("--restore");
  if (args.purge !== undefined) used.push("--purge");
  if (args.dropKeepRef !== undefined) used.push("--drop-keep-ref");
  if (args.dropAllKeepRefs) used.push("--drop-all-keep-refs");
  return used;
}

/**
 * An id or name given as `""` — `--purge "$ID"` with `$ID` unset — used to fall
 * through to a listing and exit 0, so a script deleting something got a table
 * and a success code. A destructive action with no target is a usage error.
 */
function emptyTarget(value: string | undefined, what: string): string | true {
  return value !== undefined && value.trim() === "" ? `${what} must not be empty` : true;
}

const waitOption = {
  type: "boolean",
  description: "Wait for a repository lock another process holds instead of failing immediately.",
} as const;

/**
 * `sync-worktrees trash` and its subcommands. `trash` on its own is `trash
 * list`. The flag forms from before the subcommands (`trash --restore <id>`)
 * still parse, with their old mutual exclusions, and are hidden from help.
 */
export function buildTrashCommand(y: Argv, onParsed: (options: TrashCommandOptions) => void): Argv {
  const emit = (args: { config?: string; filter?: string }, action: TrashAction, wait = false): void => {
    onParsed({ config: args.config, filter: args.filter, action, wait });
  };

  return (
    y
      .option("config", {
        alias: "c",
        type: "string",
        description: "Path to JavaScript config file (auto-detected in CWD when omitted).",
      })
      .option("filter", {
        alias: "f",
        type: "string",
        description: "Select exactly one repository by name.",
      })
      .command(
        "list",
        "List trash entries and permanent keep refs (the default)",
        (sub) =>
          sub.option("json", {
            type: "boolean",
            description: "Print the listing as JSON instead of a table.",
          }),
        (args) => {
          emit(args, { kind: "list", json: args.json === true });
        },
      )
      .command(
        "restore <id>",
        "Put a trash entry back at its original path",
        (sub) =>
          sub
            .positional("id", { type: "string", demandOption: true, description: "A listed trash entry id." })
            .option("wait", waitOption)
            .check((args) => emptyTarget(args.id, "The trash entry id")),
        (args) => {
          emit(args, { kind: "restore", id: args.id }, args.wait === true);
        },
      )
      .command(
        "purge [id]",
        "Permanently delete an entry now, or every entry with --all",
        (sub) =>
          sub
            .positional("id", { type: "string", description: "A listed trash entry id." })
            .option("all", {
              type: "boolean",
              description: "Delete every listed trash entry behind one confirmation.",
            })
            .option("wait", waitOption)
            .check((args) => {
              if (args.id !== undefined && args.all === true) return "Give a trash entry id or --all, not both";
              if (args.id === undefined && args.all !== true) return "Give a trash entry id to purge, or --all";
              return emptyTarget(args.id, "The trash entry id");
            }),
        (args) => {
          emit(
            args,
            args.all === true ? { kind: "purge-all" } : { kind: "purge", id: args.id ?? "" },
            args.wait === true,
          );
        },
      )
      .command(
        "drop-keep-ref <name>",
        "Delete one listed permanent keep ref",
        (sub) =>
          sub
            .positional("name", { type: "string", demandOption: true, description: "A keep ref name as listed." })
            .check((args) => emptyTarget(args.name, "The keep ref name")),
        (args) => {
          emit(args, { kind: "drop-keep-ref", name: args.name });
        },
      )
      .command(
        "drop-all-keep-refs",
        "Delete every listed permanent keep ref behind one confirmation",
        (sub) => sub,
        (args) => {
          emit(args, { kind: "drop-all-keep-refs" });
        },
      )
      // Options of the bare `trash` form only (global: false keeps them off the
      // subcommands). --json is the listing's; the rest are the deprecated
      // action flags, which parse exactly as they always have.
      .option("json", {
        type: "boolean",
        global: false,
        description: "Print the listing as JSON instead of a table.",
      })
      .option("restore", { type: "string", global: false, hidden: true })
      .option("purge", { type: "string", global: false, hidden: true })
      .option("drop-keep-ref", { type: "string", global: false, hidden: true })
      .option("drop-all-keep-refs", { type: "boolean", global: false, hidden: true })
      .option("wait", { type: "boolean", global: false, hidden: true })
      // Not .conflicts(): yargs keeps a conflicting key known to every
      // subcommand, so `trash restore <id> --json` would parse and ignore
      // --json. A check with global: false runs for the bare form only.
      .check(checkBareTrash, false)
      .example("$0 trash -f backend", "List one repository's trash and keep refs")
      .example("$0 trash restore <id>", "Put a worktree back where it was")
      .example("$0 trash purge --all", "Delete every entry now (typed confirmation)")
  );
}

// The mutual exclusions the flag form has always had: one action at a time;
// --json describes the listing, so pairing it with an action would promise
// structured output for something that does not produce any; and --wait is
// about the repository lock, which only restore and purge take.
const BARE_CONFLICTS: ReadonlyArray<readonly [string, string]> = [
  ["restore", "drop-keep-ref"],
  ["restore", "drop-all-keep-refs"],
  ["restore", "purge"],
  ["drop-keep-ref", "drop-all-keep-refs"],
  ["drop-keep-ref", "purge"],
  ["drop-all-keep-refs", "purge"],
  ["json", "restore"],
  ["json", "purge"],
  ["json", "drop-keep-ref"],
  ["json", "drop-all-keep-refs"],
  ["wait", "json"],
  ["wait", "drop-keep-ref"],
  ["wait", "drop-all-keep-refs"],
];

function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function checkBareTrash(args: RawArgs): string | true {
  // A boolean given as --no-json is as absent as one never typed.
  const given = (flag: string): boolean => {
    const value = args[camelCase(flag)];
    return value !== undefined && value !== false;
  };
  for (const [a, b] of BARE_CONFLICTS) {
    if (given(a) && given(b)) return `Arguments ${a} and ${b} are mutually exclusive`;
  }
  const legacy = legacyArgs(args);
  const restore = emptyTarget(legacy.restore, "The value of --restore");
  if (restore !== true) return restore;
  const purge = emptyTarget(legacy.purge, "The value of --purge");
  if (purge !== true) return purge;
  return emptyTarget(legacy.dropKeepRef, "The value of --drop-keep-ref");
}

/** The bare `trash` form: a listing, or one of the deprecated action flags. */
export function parseBareTrash(args: RawArgs): TrashCommandOptions {
  const base = { config: stringArg(args, "config"), filter: stringArg(args, "filter"), wait: args.wait === true };
  const legacy = legacyArgs(args);
  const [flag] = legacyFlagsIn(legacy);
  switch (flag) {
    case "--restore":
      return { ...base, action: { kind: "restore", id: legacy.restore ?? "" }, deprecatedFlag: flag };
    case "--purge":
      return { ...base, action: { kind: "purge", id: legacy.purge ?? "" }, deprecatedFlag: flag };
    case "--drop-keep-ref":
      return { ...base, action: { kind: "drop-keep-ref", name: legacy.dropKeepRef ?? "" }, deprecatedFlag: flag };
    case "--drop-all-keep-refs":
      return { ...base, action: { kind: "drop-all-keep-refs" }, deprecatedFlag: flag };
    default:
      return { ...base, action: { kind: "list", json: args.json === true } };
  }
}

/** For a parse error: the subcommand a deprecated flag (kebab-case, no dashes) became, if it is one. */
export function legacyFlagReplacement(flag: string): string | undefined {
  const key = `--${flag}`;
  return key in LEGACY_FLAGS ? LEGACY_FLAGS[key as LegacyTrashFlag] : undefined;
}

/** The one-line nudge a deprecated flag form prints, on stderr so piped output stays clean. */
export function deprecationHint(flag: LegacyTrashFlag): string {
  return `⚠️ 'trash ${flag}' is deprecated; use 'sync-worktrees ${LEGACY_FLAGS[flag]}' instead.`;
}

// A failure the person running `sync-worktrees trash` is expected to hit and
// can do something about: a wrong id, a destination that is already occupied,
// a lock somebody else holds, a confirmation they declined. Those get one line
// and exit code 1. Anything else keeps its stack and goes to main().catch,
// because a stack is the only useful thing to say about a bug.
class TrashCliError extends Error {}

// Ctrl+C at one of the confirmation prompts. @inquirer installs its own SIGINT
// handler and rejects with an ExitPromptError rather than letting the signal
// through, so declining a destructive prompt the most ordinary way there is
// printed "❌ Unhandled error:" and ten frames of readline internals. Matched
// by name because @inquirer/prompts does not re-export the class, and
// @inquirer/core is not a dependency of this package.
function isPromptCancellation(error: unknown): error is Error {
  return error instanceof Error && error.name === "ExitPromptError";
}

function isExpectedTrashFailure(error: unknown): error is Error {
  return error instanceof TrashCliError || error instanceof SyncWorktreesError || isPromptCancellation(error);
}

// `null`, not `0`: sizes are measured off the repository lock, so a freshly
// trashed entry is genuinely unmeasured rather than empty, and rendering it as
// "0 B" would invite exactly the wrong conclusion about what deleting it frees.
function formatTrashSize(sizeBytes: number | null): string {
  return sizeBytes === null ? "—" : formatBytes(sizeBytes);
}

function formatTrashExpiry(expiresAt: string, now: number): string {
  const parsed = new Date(expiresAt);
  const day = Number.isNaN(parsed.getTime()) ? expiresAt : parsed.toISOString().slice(0, 10);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() <= now ? `${day} (expired)` : day;
}

// Branch when there is one. An "orphan" entry has none, and then the directory
// it came from is the only thing that identifies it — dropping that would make
// those rows unreadable, which is what the old tab-separated listing at least
// got right by always printing originalPath.
function trashEntryLabel(manifest: TrashManifest, worktreeDir: string): string {
  if (manifest.branch) return manifest.branch;
  const relative = path.relative(worktreeDir, manifest.originalPath);
  return relative !== "" && !relative.startsWith("..") ? relative : manifest.originalPath;
}

// The rows this command printed from 5.2.0 until now. Kept for a piped stdout
// so that `sync-worktrees trash | cut -f1` and anything else built on the tab
// layout still works: cli-table3 draws box characters and ANSI colour with no
// terminal detection of its own, so sending the table down a pipe would hand a
// script escape sequences instead of fields. A human at a terminal gets the
// table; everything else gets exactly what it got before, and `--json` is the
// shape to build anything new on.
function printTrashRows(entries: TrashEntry[], keepRefs: string[]): void {
  for (const { manifest } of entries) {
    console.log(`${manifest.id}\t${manifest.reason}\t${manifest.expiresAt}\t${manifest.originalPath}`);
  }
  for (const ref of keepRefs) console.log(`KEEP\t${ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)}`);
}

function printTrashTable(entries: TrashEntry[], keepRefs: string[], worktreeDir: string): void {
  if (!process.stdout.isTTY) {
    printTrashRows(entries, keepRefs);
    return;
  }
  if (entries.length === 0) {
    console.log("No trash entries.");
  } else {
    const now = Date.now();
    const table = new Table({
      head: ["Id", "Branch / path", "Reason", "Size", "Expires", "Restores as", "Keep on reap"],
      style: { head: ["cyan", "bold"], border: ["gray"] },
    });
    for (const { manifest } of entries) {
      table.push([
        manifest.id,
        trashEntryLabel(manifest, worktreeDir),
        manifest.reason,
        formatTrashSize(manifest.sizeBytes),
        formatTrashExpiry(manifest.expiresAt, now),
        isWorktreeRestorable(manifest) ? "worktree" : "files only",
        manifest.keepPinOnReap === true ? "yes" : "",
      ]);
    }
    console.log(table.toString());
  }

  if (keepRefs.length > 0) {
    console.log(`\nPermanent keep refs (commits held past payload expiry):`);
    for (const ref of keepRefs) console.log(`  ${ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)}`);
  }
}

function printTrashJson(entries: TrashEntry[], invalid: string[], keepRefs: string[]): void {
  console.log(
    JSON.stringify(
      {
        entries: entries.map(({ manifest }) => ({
          id: manifest.id,
          branch: manifest.branch,
          reason: manifest.reason,
          originalPath: manifest.originalPath,
          deletedAt: manifest.deletedAt,
          expiresAt: manifest.expiresAt,
          // Stays null when nothing has measured this payload yet.
          sizeBytes: manifest.sizeBytes,
          restoresAsWorktree: isWorktreeRestorable(manifest),
          keepPinOnReap: manifest.keepPinOnReap === true,
          source: manifest.source,
        })),
        invalidEntries: invalid,
        keepRefs: keepRefs.map((ref) => ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)),
      },
      null,
      2,
    ),
  );
}

/** How an action is named in errors: the spelling the person typed. */
function actionLabel(options: TrashCliOptions): string {
  if (options.deprecatedFlag) return options.deprecatedFlag;
  return options.action.kind === "purge-all" ? "'trash purge --all'" : `'trash ${options.action.kind}'`;
}

function requireTrashTTY(label: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TrashCliError(`${label} requires an interactive TTY`);
  }
}

export async function runTrash(configPath: string, options: TrashCliOptions): Promise<void> {
  if (options.deprecatedFlag) console.warn(deprecationHint(options.deprecatedFlag));
  try {
    await executeTrash(configPath, options);
  } catch (error) {
    if (!isExpectedTrashFailure(error)) throw error;
    console.error(`❌ ${redactSecretsInText(error.message)}`);
    process.exitCode = 1;
  }
}

async function executeTrash(configPath: string, options: TrashCliOptions): Promise<void> {
  const configLoader = new ConfigLoaderService();
  // Config loading throws plain Errors as well as typed ConfigErrors — a config
  // file is user-supplied JS — and a config someone can fix is never a bug in
  // this tool. `list` and the sync command already report these as one line;
  // without this, `trash` was the only command that answered a missing
  // `repoUrl` with a stack trace.
  let repositories;
  try {
    ({ repositories } = await configLoader.buildRepositories(configPath, { filter: options.filter }));
  } catch (error) {
    throw new TrashCliError(`Error loading config file: ${configLoadErrorMessage(error)}`);
  }
  if (repositories.length !== 1) {
    throw new TrashCliError(
      `Trash operations require exactly one repository; matched ${repositories.length}. Use --filter.`,
    );
  }

  const service = new WorktreeSyncService(repositories[0]);
  if (service.isCloneMode()) {
    throw new TrashCliError("Trash operations are only available for worktree-mode repositories");
  }
  const { action } = options;
  // A bounded budget, never an open-ended block: see DEFAULT_CONFIG.LOCK_WAIT_MS.
  // Announced before the wait begins, and only for the operations that take
  // the lock — a listing takes none, so saying it would wait for one is a lie
  // told to whoever is watching the terminal.
  const takesLock = action.kind === "restore" || action.kind === "purge" || action.kind === "purge-all";
  const lockWaitMs = options.wait && takesLock ? DEFAULT_CONFIG.LOCK_WAIT_MS : undefined;
  if (lockWaitMs !== undefined) {
    console.log(
      `⏳ Waiting up to ${Math.round(lockWaitMs / 1000)}s for the repository lock if another process holds it`,
    );
  }

  switch (action.kind) {
    case "restore": {
      const manifest = await service.restoreFromTrash(action.id, { lockWaitMs });
      console.log(`✅ Restored ${manifest.id} to ${manifest.originalPath}`);
      return;
    }
    case "purge":
      return purgeTrashEntry(service, action.id, lockWaitMs, actionLabel(options));
    case "purge-all":
      return purgeAllTrashEntries(service, lockWaitMs, actionLabel(options));
    case "drop-keep-ref":
      return dropKeepRef(service, action.name, actionLabel(options));
    case "drop-all-keep-refs":
      return dropAllKeepRefs(service, actionLabel(options));
    case "list":
      return listTrash(service, action.json, repositories[0].worktreeDir);
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled trash action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function listTrash(service: WorktreeSyncService, json: boolean, worktreeDir: string): Promise<void> {
  // Deliberately listEntries, not listEntriesWithSizes: sizing execs `du` over
  // every payload, node_modules and all, and a listing that waits minutes to
  // fill one column is worse than a column that says "—" for what nothing has
  // measured yet.
  const { entries, invalid } = await service.listTrashEntries();
  const keepRefs = await service.listKeepRefs();
  if (json) {
    printTrashJson(entries, invalid, keepRefs);
    return;
  }
  printTrashTable(entries, keepRefs, worktreeDir);
  for (const invalidPath of invalid) console.warn(`⚠️ Invalid trash entry left untouched: ${invalidPath}`);
}

async function dropKeepRef(service: WorktreeSyncService, name: string, label: string): Promise<void> {
  requireTrashTTY(label);
  const confirmation = await input({ message: `Type '${name}' to confirm deleting this keep ref:` });
  if (confirmation !== name) {
    throw new TrashCliError("Keep ref deletion was not confirmed");
  }
  await service.deleteKeepRef(name);
  console.log(`✅ Deleted ${name}`);
}

async function dropAllKeepRefs(service: WorktreeSyncService, label: string): Promise<void> {
  requireTrashTTY(label);
  // The names are read here, before the confirmation, and handed to the
  // service as the set to act on: a sync running alongside this command can
  // mint keep refs for entries it has just reaped, and those were never on
  // screen. See deleteKeepRefs.
  const names = (await service.listKeepRefs()).map((ref) => ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length));
  if (names.length === 0) {
    console.log("No keep refs to drop.");
    return;
  }
  const phrase = `drop ${names.length}`;
  const confirmation = await input({
    message:
      `Deleting ${names.length} keep ref(s) makes their commits eligible for 'git gc' and cannot be undone. ` +
      `Type '${phrase}' to confirm:`,
  });
  if (confirmation !== phrase) {
    throw new TrashCliError("Keep ref deletion was not confirmed");
  }
  const dropped = await service.deleteKeepRefs(names);
  console.log(`✅ Deleted ${dropped.deleted} keep ref(s)`);
  for (const ref of dropped.retained) {
    console.log(`   Retained ${ref} — a '.diverged/' directory still depends on it`);
  }
  for (const error of dropped.errors) console.warn(`⚠️ Could not delete ${error}`);
}

// Permanent deletion of one entry, gated exactly like the keep-ref drops: an
// interactive TTY, a typed confirmation naming what is being destroyed, and an
// audit record — the last written by the reap path inside the lock, so it
// records the attempt and not merely the intent.
//
// The entry is read once before the prompt so the prompt can say whether this
// is a keep-on-reap entry, whose commits reached no remote and whose payload
// may be the only copy. The purge itself re-reads under the lock; this listing
// only decides what the person is told.
async function purgeTrashEntry(
  service: WorktreeSyncService,
  id: string,
  lockWaitMs: number | undefined,
  label: string,
): Promise<void> {
  requireTrashTTY(label);
  const { entries } = await service.listTrashEntries();
  const entry = entries.find((candidate) => candidate.manifest.id === id);
  if (!entry) throw new TrashCliError(`No trash entry with id '${id}'`);

  const keepNote = entry.manifest.keepPinOnReap
    ? ` Its commits were on no remote when it was trashed, so '${GIT_CONSTANTS.KEEP_REF_PREFIX}${id}' is created first and the files are deleted only if that succeeds.`
    : "";
  const confirmation = await input({
    message:
      `Deleting trash entry '${id}' removes its files permanently and cannot be undone.${keepNote} ` +
      `Type '${id}' to confirm:`,
  });
  if (confirmation !== id) throw new TrashCliError("Trash entry deletion was not confirmed");

  const result = await service.purgeTrashEntry(id, { lockWaitMs });
  if (!result.deleted) {
    for (const ref of result.keepRefsMinted) console.log(`   Kept commits at '${ref}'`);
    throw new TrashCliError(
      `Trash entry '${id}' was not deleted and stays listed: ${result.errors.join("; ") || "no reason reported"}`,
    );
  }
  console.log(`✅ Purged ${id}`);
  // Ref and commit only. The reap path logs the full "recover with: git branch
  // <name> <oid>" line as it mints the ref, and printing that verbatim a second
  // time is how a two-line result becomes four lines of the same sentence.
  for (const ref of result.keepRefsMinted) {
    console.log(`   Commits kept at '${ref}' (${entry.manifest.headOid})`);
  }
  for (const error of result.errors) console.warn(`⚠️ ${error}`);
}

// Every listed entry behind one typed confirmation. The ids are read before the
// prompt and are the whole selection: an entry a concurrent sync trashes while
// the person is typing was never on screen, so it is not touched. Each entry
// goes through the same single-entry purge as `trash purge <id>` — the same
// lock, the same keep ref minted first for a keep-on-reap entry — and one that
// fails is reported and left listed without stopping the rest.
async function purgeAllTrashEntries(
  service: WorktreeSyncService,
  lockWaitMs: number | undefined,
  label: string,
): Promise<void> {
  requireTrashTTY(label);
  const { entries } = await service.listTrashEntries();
  if (entries.length === 0) {
    console.log("No trash entries to purge.");
    return;
  }

  const pinned = entries.filter((entry) => entry.manifest.keepPinOnReap === true).length;
  const keepNote =
    pinned > 0
      ? ` ${pinned} of them hold commits that were on no remote when trashed; a permanent keep ref is created for each first and its files are deleted only if that succeeds.`
      : "";
  const phrase = `purge ${entries.length}`;
  const confirmation = await input({
    message:
      `Deleting ${entries.length} trash entr${entries.length === 1 ? "y" : "ies"} removes their files permanently and cannot be undone.${keepNote} ` +
      `Type '${phrase}' to confirm:`,
  });
  if (confirmation !== phrase) throw new TrashCliError("Trash entry deletion was not confirmed");

  let purged = 0;
  const failures: string[] = [];
  for (const { manifest } of entries) {
    try {
      const result = await service.purgeTrashEntry(manifest.id, { lockWaitMs });
      for (const ref of result.keepRefsMinted) {
        console.log(`   Commits of ${manifest.id} kept at '${ref}' (${manifest.headOid})`);
      }
      if (result.deleted) {
        purged++;
        for (const error of result.errors) console.warn(`⚠️ ${error}`);
      } else {
        failures.push(`${manifest.id}: ${result.errors.join("; ") || "no reason reported"}`);
      }
    } catch (error) {
      if (!isExpectedTrashFailure(error)) throw error;
      failures.push(`${manifest.id}: ${error.message}`);
    }
  }

  console.log(`✅ Purged ${purged} of ${entries.length} trash entr${entries.length === 1 ? "y" : "ies"}`);
  if (failures.length > 0) {
    for (const failure of failures) console.warn(`⚠️ Not purged: ${redactSecretsInText(failure)}`);
    throw new TrashCliError(`${failures.length} trash entr${failures.length === 1 ? "y was" : "ies were"} not purged`);
  }
}
