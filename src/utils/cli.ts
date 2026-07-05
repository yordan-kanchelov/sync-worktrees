import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export const CLI_COMMANDS = {
  RUN: "run",
  INIT: "init",
  LIST: "list",
} as const;

export type CliCommand = (typeof CLI_COMMANDS)[keyof typeof CLI_COMMANDS];

export type CliOptions =
  | { command: typeof CLI_COMMANDS.RUN; config?: string; runOnce: boolean }
  | { command: typeof CLI_COMMANDS.INIT; config?: string; force: boolean }
  | { command: typeof CLI_COMMANDS.LIST; config?: string; filter?: string };

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
