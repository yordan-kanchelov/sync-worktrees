import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export const CLI_COMMANDS = {
  RUN: "run",
  INIT: "init",
  LIST: "list",
  TRASH: "trash",
} as const;

export type CliOptions =
  | { command: typeof CLI_COMMANDS.RUN; config?: string; runOnce: boolean }
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

export function parseArguments(argv: string[] = hideBin(process.argv)): CliOptions {
  let parsed: CliOptions | undefined;

  yargs(argv)
    .scriptName("sync-worktrees")
    .parserConfiguration({ "camel-case-expansion": false })
    .strict()
    .command(
      "$0",
      "Sync git worktrees against a config file",
      (y) =>
        y
          .option("config", {
            alias: "c",
            type: "string",
            description: "Path to JavaScript config file (auto-detected in CWD when omitted).",
          })
          .option("runOnce", {
            type: "boolean",
            description: "Run a sync once and exit, overriding config runOnce settings for this invocation.",
            default: false,
          }),
      (args) => {
        parsed = {
          command: CLI_COMMANDS.RUN,
          config: args.config,
          runOnce: args.runOnce,
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
          .option("dropKeepRef", {
            type: "string",
            description: "Delete a permanent keep ref by its listed name.",
          })
          .option("dropAllKeepRefs", {
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
          .conflicts("restore", "dropKeepRef")
          .conflicts("restore", "dropAllKeepRefs")
          .conflicts("restore", "purge")
          .conflicts("dropKeepRef", "dropAllKeepRefs")
          .conflicts("dropKeepRef", "purge")
          .conflicts("dropAllKeepRefs", "purge")
          // --json describes the listing, so pairing it with an action would
          // promise structured output for something that does not produce any.
          .conflicts("json", "restore")
          .conflicts("json", "purge")
          .conflicts("json", "dropKeepRef")
          .conflicts("json", "dropAllKeepRefs")
          // --wait is about the repository lock, which only the two operations
          // that take it can be made to wait for.
          .conflicts("wait", "json")
          .conflicts("wait", "dropKeepRef")
          .conflicts("wait", "dropAllKeepRefs"),
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
    .demandCommand(0, 0)
    .fail((msg, err) => {
      if (err) throw err;
      const subcommandFlag = argv.find((arg) => arg === "--init" || arg === "--list");
      if (subcommandFlag) {
        const subcommand = subcommandFlag.slice(2);
        console.error(`\n❌ '${subcommandFlag}' is not a flag. '${subcommand}' is a subcommand.`);
        console.error(`💡 Run: sync-worktrees ${subcommand}`);
      } else {
        console.error(msg);
      }
      console.error(`\nRun 'sync-worktrees --help' to see available commands.`);
      process.exit(1);
    })
    .help()
    .alias("help", "h")
    .version()
    .parseSync();

  if (!parsed) {
    throw new Error("Failed to parse CLI arguments");
  }

  return parsed;
}
