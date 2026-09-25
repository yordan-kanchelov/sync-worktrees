import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { suggestConfigKey } from "./unknown-config-keys";

export const CLI_COMMANDS = {
  RUN: "run",
  INIT: "init",
  LIST: "list",
  TRASH: "trash",
} as const;

export type CliOptions =
  | {
      command: typeof CLI_COMMANDS.RUN;
      config?: string;
      runOnce: boolean;
      debug: boolean;
      filter?: string;
      quiet: boolean;
    }
  | { command: typeof CLI_COMMANDS.INIT; config?: string; force: boolean }
  | { command: typeof CLI_COMMANDS.LIST; config?: string; filter?: string }
  | ({ command: typeof CLI_COMMANDS.TRASH; config?: string } & TrashCliOptions);

/** Everything `sync-worktrees trash` accepts beyond `--config`. */
export interface TrashCliOptions {
  filter?: string;
  restore?: string;
  purge?: string;
  dropKeepRef?: string;
  dropAllKeepRefs?: boolean;
  json?: boolean;
  wait?: boolean;
}

const DOCS_URL = "https://github.com/yordan-kanchelov/sync-worktrees/tree/main/docs";

/** The words a user can type as the first argument, for "did you mean" hints. */
/** The commands other than the default one; `sync` is the default command's explicit name. */
const SUBCOMMAND_NAMES = [CLI_COMMANDS.INIT, CLI_COMMANDS.LIST, CLI_COMMANDS.TRASH, "completion"] as const;
const COMMAND_NAMES = ["sync", ...SUBCOMMAND_NAMES] as const;

/** Every long flag any command accepts, in its canonical kebab-case spelling. */
const FLAG_NAMES = [
  "config",
  "run-once",
  "debug",
  "filter",
  "quiet",
  "force",
  "restore",
  "purge",
  "drop-keep-ref",
  "drop-all-keep-refs",
  "json",
  "wait",
  "help",
  "version",
] as const;

/** Root-command flags, which yargs' completion leaves out because `$0` never runs its builder there. */
const ROOT_FLAG_NAMES = ["config", "run-once", "debug", "filter", "quiet"] as const;

function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function wasTyped(name: string, argv: readonly string[]): boolean {
  const flag = name.length === 1 ? `-${name}` : `--${name}`;
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * What to print for a failed parse: yargs' message, then "did you mean" hints
 * for an "Unknown argument(s): a, b" failure.
 *
 * Camel-case expansion makes yargs report one unknown flag under both
 * spellings (`list --runOnce` fails with "runOnce, run-once"), so the names
 * are collapsed to the one that was typed. The root command is a default
 * command, so yargs' own recommendCommands() never fires (it is skipped
 * whenever a default command exists) and a mistyped subcommand arrives here as
 * an unknown positional instead. A name that is already a real command or flag
 * gets no hint: it was given in the wrong place, not misspelled.
 */
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
  for (const { name, positional } of unknown.values()) {
    if (positional) {
      // A real command in the wrong place (`trash list`) is not a typo.
      if ((COMMAND_NAMES as readonly string[]).includes(name)) continue;
      const command = suggestConfigKey(name, COMMAND_NAMES);
      if (command) lines.push(`💡 Did you mean 'sync-worktrees ${command}'?`);
      continue;
    }
    const kebab = toKebabCase(name);
    if ((FLAG_NAMES as readonly string[]).includes(kebab)) continue;
    const flag = suggestConfigKey(kebab, FLAG_NAMES);
    if (flag) lines.push(`💡 Did you mean '--${flag}'?`);
  }
  return lines;
}

/**
 * Shell completion: yargs' own suggestions, plus the root command's flags at
 * the top level (a default command's builder only runs when it is executed,
 * so yargs never sees them there), minus the `--c`/`--f` spellings it derives
 * from one-letter aliases, which no parser accepts.
 */
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

export function parseArguments(argv: string[] = hideBin(process.argv)): CliOptions {
  let parsed: CliOptions | undefined;

  yargs(argv)
    .scriptName("sync-worktrees")
    // Kebab-case is the canonical spelling shown in --help; camel-case
    // expansion keeps the camelCase spellings (`--runOnce`, `--dropKeepRef`)
    // working as aliases. strict() still rejects anything neither spelling names.
    .parserConfiguration({ "camel-case-expansion": true })
    .strict()
    .command(
      ["$0", "sync"],
      "Sync git worktrees against a config file",
      (y) =>
        y
          .option("config", {
            alias: "c",
            type: "string",
            description: "Path to JavaScript config file (auto-detected in CWD when omitted).",
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
            type: "string",
            description: "Only sync repositories whose name matches (wildcards, comma-separated).",
          })
          .option("quiet", {
            alias: "q",
            type: "boolean",
            description: "One-shot runs: print only warnings, errors and the final summary line.",
            default: false,
          }),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.RUN,
          config: args.config,
          runOnce: args.runOnce,
          debug: args.debug,
          filter: args.filter,
          quiet: args.quiet,
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
            type: "string",
            description: "Target path for the generated config file (default: ./sync-worktrees.config.js).",
          })
          .option("force", {
            type: "boolean",
            description: "Overwrite the target file if it already exists.",
            default: false,
          }),
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
            type: "string",
            description: "Path to JavaScript config file (auto-detected in CWD when omitted).",
          })
          .option("filter", {
            alias: "f",
            type: "string",
            description: "Filter repositories by name (wildcards, comma-separated).",
          }),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.LIST,
          config: args.config,
          filter: args.filter,
        };
      },
    )
    .command(
      CLI_COMMANDS.TRASH,
      "List, restore, or permanently delete trash entries for a single repository",
      (y) =>
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
          .option("restore", {
            type: "string",
            description: "Restore the trash entry with this id.",
          })
          .option("drop-keep-ref", {
            type: "string",
            description: "Delete a permanent keep ref by its listed name.",
          })
          .option("drop-all-keep-refs", {
            type: "boolean",
            description: "Delete every listed permanent keep ref behind one confirmation.",
          })
          .option("purge", {
            type: "string",
            description: "Permanently delete the trash entry with this id, ahead of its expiry.",
          })
          .option("json", {
            type: "boolean",
            description: "Print the listing as JSON instead of a table.",
          })
          .option("wait", {
            type: "boolean",
            description:
              "With --restore or --purge, wait for a repository lock another process holds instead of failing immediately.",
          })
          .conflicts("restore", "drop-keep-ref")
          .conflicts("restore", "drop-all-keep-refs")
          .conflicts("restore", "purge")
          .conflicts("drop-keep-ref", "drop-all-keep-refs")
          .conflicts("drop-keep-ref", "purge")
          .conflicts("drop-all-keep-refs", "purge")
          // --json describes the listing, so pairing it with an action would
          // promise structured output for something that does not produce any.
          .conflicts("json", "restore")
          .conflicts("json", "purge")
          .conflicts("json", "drop-keep-ref")
          .conflicts("json", "drop-all-keep-refs")
          // --wait is about the repository lock, which only the two operations
          // that take it can be made to wait for.
          .conflicts("wait", "json")
          .conflicts("wait", "drop-keep-ref")
          .conflicts("wait", "drop-all-keep-refs"),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.TRASH,
          config: args.config,
          filter: args.filter,
          restore: args.restore,
          purge: args.purge,
          dropKeepRef: args.dropKeepRef,
          dropAllKeepRefs: args.dropAllKeepRefs,
          json: args.json,
          wait: args.wait,
        };
      },
    )
    .completion("completion", "Print a bash/zsh completion script", completeArguments)
    .example("$0 --run-once", "Sync once and exit (cron, CI)")
    .example("$0 --run-once -q -f backend", "Sync one repo; print only problems and the summary")
    .example('$0 list --filter "frontend-*"', "Show which repositories a filter matches")
    .example("$0 trash -f backend --restore <id>", "Restore a worktree from the trash")
    .example("$0 completion >> ~/.bashrc", "Install shell completion")
    .epilog(`Documentation: ${DOCS_URL}`)
    .demandCommand(0, 0)
    .fail((msg, err) => {
      if (err) throw err;
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
    // yargs would otherwise look for package.json next to its own install
    // directory, which from a bundled or pnpm-installed copy is not ours.
    .version(__SYNC_WORKTREES_VERSION__)
    .alias("version", "V")
    .parseSync();

  if (!parsed) {
    throw new Error("Failed to parse CLI arguments");
  }

  return parsed;
}
