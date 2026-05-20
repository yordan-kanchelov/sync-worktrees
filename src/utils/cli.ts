import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export type CliCommand = "run" | "init" | "list";

export interface CliOptions {
  command: CliCommand;
  config?: string;
  filter?: string;
  force?: boolean;
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
        y.option("config", {
          alias: "c",
          type: "string",
          description: "Path to JavaScript config file (auto-detected in CWD when omitted).",
        }),
      (args) => {
        parsed = {
          command: "run",
          config: args.config,
        };
      },
    )
    .command(
      "init",
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
          command: "init",
          config: args.config,
          force: args.force,
        };
      },
    )
    .command(
      "list",
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
          command: "list",
          config: args.config,
          filter: args.filter,
        };
      },
    )
    .demandCommand(0, 0)
    .help()
    .alias("help", "h")
    .version()
    .parseSync();

  if (!parsed) {
    throw new Error("Failed to parse CLI arguments");
  }

  return parsed;
}
