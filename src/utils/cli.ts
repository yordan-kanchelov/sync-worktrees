import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  buildTrashCommand,
  legacyFlagReplacement,
  parseBareTrash,
  TRASH_FLAG_NAMES,
  TRASH_SUBCOMMAND_NAMES,
} from "../cli/trash-command";

import { CONFIG_OPTION_DESCRIPTION } from "./config-discovery";
import { suggestConfigKey } from "./unknown-config-keys";

import type { TrashCliOptions } from "../cli/trash-command";

export const CLI_COMMANDS = {
  RUN: "run",
  INIT: "init",
  LIST: "list",
  TRASH: "trash",
  DOCTOR: "doctor",
} as const;

export type CliOptions =
  | {
      command: typeof CLI_COMMANDS.RUN;
      config?: string;
      runOnce: boolean;
      debug: boolean;
      filter?: string;
      quiet: boolean;
      dryRun: boolean;
      json: boolean;
    }
  | { command: typeof CLI_COMMANDS.INIT; config?: string; force: boolean }
  | { command: typeof CLI_COMMANDS.LIST; config?: string; filter?: string; json: boolean }
  | ({ command: typeof CLI_COMMANDS.TRASH; config?: string } & TrashCliOptions)
  | { command: typeof CLI_COMMANDS.DOCTOR; config?: string; filter?: string; json: boolean; quiet: boolean };

export type { TrashCliOptions };

const DOCS_URL = "https://github.com/yordan-kanchelov/sync-worktrees/tree/main/docs";

const SUBCOMMAND_NAMES = [
  CLI_COMMANDS.INIT,
  CLI_COMMANDS.LIST,
  CLI_COMMANDS.TRASH,
  CLI_COMMANDS.DOCTOR,
  "completion",
] as const;
const COMMAND_NAMES = ["sync", ...SUBCOMMAND_NAMES] as const;

const FLAG_NAMES = [
  "config",
  "run-once",
  "debug",
  "filter",
  "quiet",
  "dry-run",
  "force",
  ...TRASH_FLAG_NAMES,
  "help",
  "version",
] as const;

const ROOT_FLAG_NAMES = ["config", "run-once", "debug", "filter", "quiet", "dry-run", "json"] as const;

function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function wasTyped(name: string, argv: readonly string[]): boolean {
  const flag = name.length === 1 ? `-${name}` : `--${name}`;
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

const TRASH_FLAG_HOMES: Readonly<Record<string, string>> = {
  json: "'trash list'",
  wait: "'trash restore' and 'trash purge'",
  all: "'trash purge'",
};

function namesTrashCommand(argv: readonly string[]): boolean {
  return argv.some((arg, i) => {
    if (arg !== CLI_COMMANDS.TRASH) return false;
    const previous = argv[i - 1];
    return previous === undefined || !previous.startsWith("-") || previous.includes("=");
  });
}

export function describeParseFailure(message: string, argv: readonly string[]): string[] {
  const match = /^Unknown arguments?: (.+)$/.exec(message.trim());
  if (!match) return [message];

  const unknown = new Map<string, { name: string; positional: boolean }>();
  for (const name of match[1].split(", ")) {
    const positional = argv.includes(name);
    const key = positional ? `positional:${name}` : toKebabCase(name);
    if (!unknown.has(key) || wasTyped(name, argv)) unknown.set(key, { name, positional });
  }

  const names = [...unknown.values()].map(({ name }) => name);
  const lines = [`Unknown argument${names.length === 1 ? "" : "s"}: ${names.join(", ")}`];
  const underTrash = namesTrashCommand(argv);
  for (const { name, positional } of unknown.values()) {
    if (positional && underTrash && name !== CLI_COMMANDS.TRASH) {
      if ((TRASH_SUBCOMMAND_NAMES as readonly string[]).includes(name)) continue;
      const subcommand = suggestConfigKey(name, TRASH_SUBCOMMAND_NAMES);
      if (subcommand) lines.push(`💡 Did you mean 'sync-worktrees trash ${subcommand}'?`);
      continue;
    }
    if (positional) {
      if ((COMMAND_NAMES as readonly string[]).includes(name)) continue;
      const command = suggestConfigKey(name, COMMAND_NAMES);
      if (command) lines.push(`💡 Did you mean 'sync-worktrees ${command}'?`);
      continue;
    }
    const kebab = toKebabCase(name);
    const replacement = underTrash ? legacyFlagReplacement(kebab) : undefined;
    if (replacement) {
      lines.push(
        `💡 --${kebab} is the old spelling of '${replacement}' and cannot be combined with a trash subcommand.`,
      );
      continue;
    }
    const home = underTrash ? TRASH_FLAG_HOMES[kebab] : undefined;
    if (home) {
      lines.push(`💡 --${kebab} belongs to ${home}.`);
      continue;
    }
    if ((FLAG_NAMES as readonly string[]).includes(kebab)) continue;
    const flag = suggestConfigKey(kebab, FLAG_NAMES);
    if (flag) lines.push(`💡 Did you mean '--${flag}'?`);
  }
  return lines;
}

function completeArguments(
  current: string,
  argv: { _: Array<string | number> },
  completionFilter: (onCompleted?: (err: Error | null, completions: string[] | undefined) => void) => void,
  done: (completions: string[]) => void,
): void {
  completionFilter((err, completions) => {
    const onRoot = !argv._.some((word) => (SUBCOMMAND_NAMES as readonly string[]).includes(String(word)));
    const rootFlags =
      onRoot && current.startsWith("-")
        ? ROOT_FLAG_NAMES.map((flag) => `--${flag}`).filter((flag) => flag.startsWith(current))
        : [];
    const all = [...(err ? [] : (completions ?? [])), ...rootFlags];
    done([...new Set(all)].filter((completion) => !/^--.(:|$)/.test(completion)));
  });
}

function checkConfigAndFilter(args: { config?: unknown; filter?: unknown }): string | true {
  if (Array.isArray(args.config)) return "--config was given more than once";
  if (typeof args.config === "string" && args.config.trim() === "") return "--config needs a non-empty path";
  const filters: unknown[] = Array.isArray(args.filter) ? args.filter : [args.filter];
  if (filters.some((value) => typeof value === "string" && value.trim() === "")) {
    return "--filter needs a non-empty pattern";
  }
  return true;
}

function joinFilter(filter: unknown): string | undefined {
  return Array.isArray(filter) ? filter.join(",") : (filter as string | undefined);
}

export function parseArguments(argv: string[] = hideBin(process.argv)): CliOptions {
  let parsed: CliOptions | undefined;

  yargs(argv)
    .scriptName("sync-worktrees")
    .parserConfiguration({ "camel-case-expansion": true })
    .strict()
    .command(
      ["$0", "sync"],
      "Sync git worktrees against a config file",
      (y) =>
        y
          .option("config", {
            alias: "c",
            requiresArg: true,
            type: "string",
            description: CONFIG_OPTION_DESCRIPTION,
          })
          .option("run-once", {
            type: "boolean",
            description: "Run a sync once and exit, overriding config runOnce settings for this invocation.",
            default: false,
          })
          .option("debug", {
            type: "boolean",
            description: "Log debug output and full error details, overriding config debug settings.",
            default: false,
          })
          .option("filter", {
            alias: "f",
            requiresArg: true,
            type: "string",
            description: "Only sync repositories whose name matches (wildcards, comma-separated).",
          })
          .option("quiet", {
            alias: "q",
            type: "boolean",
            description: "One-shot runs: print only warnings, errors and the final summary line.",
            default: false,
          })
          .option("dry-run", {
            type: "boolean",
            description:
              "Print what a sync would create, update, prune and skip, then exit without changing anything (fetches remote-tracking refs only). Implies --run-once.",
            default: false,
          })
          .option("json", {
            type: "boolean",
            description: "With --dry-run: print the plans as a JSON array instead of a report.",
            default: false,
          })
          .check((args) => !args.json || args.dryRun || "--json is only available with --dry-run.")
          .check(checkConfigAndFilter),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.RUN,
          config: args.config,
          runOnce: args.runOnce,
          debug: args.debug,
          filter: joinFilter(args.filter),
          quiet: args.quiet,
          dryRun: args.dryRun,
          json: args.json,
        };
      },
    )
    .command(
      CLI_COMMANDS.INIT,
      "Create a new config file interactively",
      (y) =>
        y
          .option("config", {
            alias: "c",
            requiresArg: true,
            type: "string",
            description: "Target path for the generated config file (default: ./sync-worktrees.config.js).",
          })
          .option("force", {
            type: "boolean",
            description: "Overwrite the target file if it already exists.",
            default: false,
          })
          .check(checkConfigAndFilter),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.INIT,
          config: args.config,
          force: args.force,
        };
      },
    )
    .command(
      CLI_COMMANDS.LIST,
      "List repositories configured in a config file and exit",
      (y) =>
        y
          .option("config", {
            alias: "c",
            requiresArg: true,
            type: "string",
            description: CONFIG_OPTION_DESCRIPTION,
          })
          .option("filter", {
            alias: "f",
            requiresArg: true,
            type: "string",
            description: "Filter repositories by name (wildcards, comma-separated).",
          })
          .option("json", {
            type: "boolean",
            description: "Print the repositories as a JSON array instead of a report.",
            default: false,
          })
          .check(checkConfigAndFilter),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.LIST,
          config: args.config,
          filter: joinFilter(args.filter),
          json: args.json,
        };
      },
    )
    .command(
      CLI_COMMANDS.TRASH,
      "List, restore, or permanently delete trash entries for a single repository",
      (y) =>
        buildTrashCommand(y, (options) => {
          parsed = { command: CLI_COMMANDS.TRASH, ...options };
        }),
      (args) => {
        parsed = { command: CLI_COMMANDS.TRASH, ...parseBareTrash(args) };
      },
    )
    .command(
      CLI_COMMANDS.DOCTOR,
      "Check Node, git, the config and each repository's remote and directories",
      (y) =>
        y
          .option("config", {
            alias: "c",
            requiresArg: true,
            type: "string",
            description: CONFIG_OPTION_DESCRIPTION,
          })
          .option("filter", {
            alias: "f",
            requiresArg: true,
            type: "string",
            description: "Only check repositories whose name matches (wildcards, comma-separated).",
          })
          .option("json", {
            type: "boolean",
            description: "Print the checks as a JSON array instead of a report.",
            default: false,
          })
          .option("quiet", {
            alias: "q",
            type: "boolean",
            description: "Print only warnings, failures and the summary line (ignored with --json).",
            default: false,
          })
          .check(checkConfigAndFilter),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.DOCTOR,
          config: args.config,
          filter: joinFilter(args.filter),
          json: args.json,
          quiet: args.quiet,
        };
      },
    )
    .completion("completion", "Print a bash/zsh completion script", completeArguments)
    .example("$0 --run-once", "Sync once and exit (cron, CI)")
    .example("$0 --run-once -q -f backend", "Sync one repo; print only problems and the summary")
    .example("$0 --dry-run -f backend", "Show what a sync would do to one repo, without doing it")
    .example('$0 list --filter "frontend-*"', "Show which repositories a filter matches")
    .example("$0 trash restore <id>", "Restore a worktree from the trash")
    .example("$0 doctor", "Check Node, git, the config, each remote and the directories")
    .example("$0 completion >> ~/.bashrc", "Install shell completion")
    .epilog(`Documentation: ${DOCS_URL}`)
    .demandCommand(0, 0)
    .fail((msg, err) => {
      if (err && typeof (err as unknown) !== "string" && err.name !== "YError") throw err;
      const subcommandFlag = argv.find((arg) => arg === "--init" || arg === "--list");
      if (subcommandFlag) {
        const subcommand = subcommandFlag.slice(2);
        console.error(`\n❌ '${subcommandFlag}' is not a flag. '${subcommand}' is a subcommand.`);
        console.error(`💡 Run: sync-worktrees ${subcommand}`);
      } else {
        for (const line of describeParseFailure(msg, argv)) console.error(line);
      }
      console.error(`\nRun 'sync-worktrees --help' to see available commands.`);
      process.exit(1);
    })
    .help()
    .alias("help", "h")
    .version(__SYNC_WORKTREES_VERSION__)
    .alias("version", "V")
    .parseSync();

  if (!parsed) {
    throw new Error("Failed to parse CLI arguments");
  }

  return parsed;
}
