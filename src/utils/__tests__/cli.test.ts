import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import { describeParseFailure, parseArguments } from "../cli";

describe("parseArguments", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the run command with no flags", () => {
    const opts = parseArguments([]);
    if (opts.command !== "run") throw new Error("expected run command");
    expect(opts.config).toBeUndefined();
    expect(opts.runOnce).toBe(false);
  });

  it("parses --config", () => {
    const opts = parseArguments(["--config", "/etc/sync.config.js"]);
    if (opts.command !== "run") throw new Error("expected run command");
    expect(opts.config).toBe("/etc/sync.config.js");
    expect(opts.runOnce).toBe(false);
  });

  it("parses --runOnce", () => {
    const opts = parseArguments(["--runOnce"]);
    if (opts.command !== "run") throw new Error("expected run command");
    expect(opts.runOnce).toBe(true);
  });

  it("parses init subcommand", () => {
    const opts = parseArguments(["init"]);
    if (opts.command !== "init") throw new Error("expected init command");
    expect(opts.config).toBeUndefined();
    expect(opts.force).toBe(false);
  });

  it("parses init --config <path> --force", () => {
    const opts = parseArguments(["init", "--config", "/tmp/new.config.js", "--force"]);
    if (opts.command !== "init") throw new Error("expected init command");
    expect(opts.config).toBe("/tmp/new.config.js");
    expect(opts.force).toBe(true);
  });

  it("parses list subcommand with --config + --filter", () => {
    const opts = parseArguments(["list", "--config", "/etc/sync.config.js", "--filter", "backend-*"]);
    if (opts.command !== "list") throw new Error("expected list command");
    expect(opts.config).toBe("/etc/sync.config.js");
    expect(opts.filter).toBe("backend-*");
  });

  it("parses trash listing and restore options", () => {
    const list = parseArguments(["trash", "--filter", "backend"]);
    if (list.command !== "trash") throw new Error("expected trash command");
    expect(list).toMatchObject({ filter: "backend", restore: undefined });

    const restore = parseArguments(["trash", "--filter", "backend", "--restore", "entry-id"]);
    if (restore.command !== "trash") throw new Error("expected trash command");
    expect(restore.restore).toBe("entry-id");

    const drop = parseArguments(["trash", "--filter", "backend", "--dropKeepRef", "keep-id"]);
    if (drop.command !== "trash") throw new Error("expected trash command");
    expect(drop.dropKeepRef).toBe("keep-id");

    const dropAll = parseArguments(["trash", "--filter", "backend", "--dropAllKeepRefs"]);
    if (dropAll.command !== "trash") throw new Error("expected trash command");
    expect(dropAll).toMatchObject({ dropAllKeepRefs: true, dropKeepRef: undefined });
  });

  it("parses trash --purge, --json and --wait", () => {
    const purge = parseArguments(["trash", "--filter", "backend", "--purge", "entry-id", "--wait"]);
    if (purge.command !== "trash") throw new Error("expected trash command");
    expect(purge).toMatchObject({ purge: "entry-id", wait: true, restore: undefined });

    const json = parseArguments(["trash", "--filter", "backend", "--json"]);
    if (json.command !== "trash") throw new Error("expected trash command");
    expect(json).toMatchObject({ json: true, purge: undefined, wait: undefined });
  });

  it.each([
    ["restore against dropKeepRef", ["trash", "--restore", "entry", "--dropKeepRef", "keep"]],
    ["restore against dropAllKeepRefs", ["trash", "--restore", "entry", "--dropAllKeepRefs"]],
    ["dropKeepRef against dropAllKeepRefs", ["trash", "--dropKeepRef", "keep", "--dropAllKeepRefs"]],
    ["purge against restore", ["trash", "--purge", "entry", "--restore", "entry"]],
    ["purge against dropKeepRef", ["trash", "--purge", "entry", "--dropKeepRef", "keep"]],
    ["purge against dropAllKeepRefs", ["trash", "--purge", "entry", "--dropAllKeepRefs"]],
    // --json describes the listing; an action produces no listing to describe.
    ["json against restore", ["trash", "--json", "--restore", "entry"]],
    ["json against purge", ["trash", "--json", "--purge", "entry"]],
    ["json against dropKeepRef", ["trash", "--json", "--dropKeepRef", "keep"]],
    ["json against dropAllKeepRefs", ["trash", "--json", "--dropAllKeepRefs"]],
    // --wait is about the repository lock, which the listing never takes.
    ["wait against json", ["trash", "--wait", "--json"]],
    ["wait against dropKeepRef", ["trash", "--wait", "--dropKeepRef", "keep"]],
    ["wait against dropAllKeepRefs", ["trash", "--wait", "--dropAllKeepRefs"]],
  ])("rejects conflicting trash mutations: %s", (_label, argv) => {
    expect(() => parseArguments(argv)).toThrow(/process\.exit/);
  });

  // `--help` is the CLI's own reference, and it is the only one that ships with
  // the binary rather than with the README. A subcommand that exists but is not
  // listed there is invisible: `trash` was added in 5.2.0 and went unmentioned
  // in the README's Subcommands list until now, which is exactly the failure
  // this pins on the side that the suite can see.
  it("lists every subcommand in --help", () => {
    expect(() => parseArguments(["--help"])).toThrow(/process\.exit/);

    const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");

    expect(output).toContain("sync-worktrees init");
    expect(output).toContain("sync-worktrees list");
    expect(output).toContain("sync-worktrees trash");
  });

  it("prints the package version for --version", () => {
    expect(() => parseArguments(["--version"])).toThrow(/process\.exit/);

    const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");

    expect(output.trim()).toBe(packageJson.version);
  });

  // The version comes from the build-time define, not from yargs' package.json
  // lookup, which starts at yargs' own install directory: from a pnpm global
  // install that finds pnpm's manifest and prints "unknown".
  it("prints the build-time version for -V", () => {
    expect(() => parseArguments(["-V"])).toThrow(/process\.exit/);

    const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");

    expect(output.trim()).toBe(__SYNC_WORKTREES_VERSION__);
  });

  it("parses --debug, off by default", () => {
    const defaults = parseArguments([]);
    const debug = parseArguments(["--runOnce", "--debug"]);
    if (defaults.command !== "run" || debug.command !== "run") throw new Error("expected run command");
    expect(defaults.debug).toBe(false);
    expect(debug.debug).toBe(true);
  });

  it("rejects removed flag --repoUrl under strict()", () => {
    expect(() => parseArguments(["--repoUrl", "https://example.com/repo.git"])).toThrow(/process\.exit/);
  });

  it("rejects unknown flag under strict()", () => {
    expect(() => parseArguments(["--unknownFlag"])).toThrow(/process\.exit/);
  });

  it("rejects unknown flag combined with init subcommand", () => {
    expect(() => parseArguments(["init", "--repoUrl", "https://example.com/repo.git"])).toThrow(/process\.exit/);
  });

  it("rejects --runOnce on subcommands", () => {
    expect(() => parseArguments(["list", "--runOnce"])).toThrow(/process\.exit/);
  });

  it("nudges --init toward the init subcommand", () => {
    expect(() => parseArguments(["--init"])).toThrow(/process\.exit/);
    const output = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(output).toContain("sync-worktrees init");
  });

  it("nudges --list toward the list subcommand", () => {
    expect(() => parseArguments(["--list"])).toThrow(/process\.exit/);
    const output = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(output).toContain("sync-worktrees list");
  });
  describe("kebab-case flags with camelCase aliases", () => {
    it.each([["--run-once"], ["--runOnce"]])("parses %s", (flag) => {
      const opts = parseArguments([flag]);
      if (opts.command !== "run") throw new Error("expected run command");
      expect(opts.runOnce).toBe(true);
    });

    it.each([
      ["--drop-keep-ref", "--drop-all-keep-refs"],
      ["--dropKeepRef", "--dropAllKeepRefs"],
    ])("parses trash %s and %s", (dropOne, dropAll) => {
      const one = parseArguments(["trash", dropOne, "keep-id"]);
      if (one.command !== "trash") throw new Error("expected trash command");
      expect(one.dropKeepRef).toBe("keep-id");

      const all = parseArguments(["trash", dropAll]);
      if (all.command !== "trash") throw new Error("expected trash command");
      expect(all.dropAllKeepRefs).toBe(true);
    });

    it.each([
      ["kebab", ["trash", "--restore", "entry", "--drop-keep-ref", "keep"]],
      ["mixed", ["trash", "--drop-keep-ref", "keep", "--dropAllKeepRefs"]],
      ["kebab against json", ["trash", "--json", "--drop-all-keep-refs"]],
    ])("keeps trash conflicts across spellings: %s", (_label, argv) => {
      expect(() => parseArguments(argv)).toThrow(/process\.exit/);
    });

    it("shows only the kebab-case spelling in --help", () => {
      expect(() => parseArguments(["trash", "--help"])).toThrow(/process\.exit/);
      const trashHelp = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
      expect(trashHelp).toContain("--drop-keep-ref");
      expect(trashHelp).toContain("--drop-all-keep-refs");
      expect(trashHelp).not.toContain("dropKeepRef");

      vi.mocked(console.log).mockClear();
      expect(() => parseArguments(["--help"])).toThrow(/process\.exit/);
      const rootHelp = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
      expect(rootHelp).toContain("--run-once");
      expect(rootHelp).not.toContain("--runOnce");
    });

    it("still rejects a flag neither spelling names", () => {
      expect(() => parseArguments(["--run-onse"])).toThrow(/process\.exit/);
      expect(() => parseArguments(["--runonce"])).toThrow(/process\.exit/);
    });
  });

  describe("sync command", () => {
    it("accepts `sync` as an explicit name for the default command", () => {
      const opts = parseArguments(["sync", "--run-once", "--config", "/etc/sync.config.js"]);
      if (opts.command !== "run") throw new Error("expected run command");
      expect(opts).toMatchObject({ runOnce: true, config: "/etc/sync.config.js" });
    });

    it("defaults --filter to unset and --quiet to off", () => {
      const opts = parseArguments([]);
      if (opts.command !== "run") throw new Error("expected run command");
      expect(opts.filter).toBeUndefined();
      expect(opts.quiet).toBe(false);
    });

    it.each([[["--filter", "backend-*", "--quiet"]], [["-f", "backend-*", "-q"]]])(
      "parses the sync filter and quiet flags: %j",
      (argv) => {
        const opts = parseArguments(argv);
        if (opts.command !== "run") throw new Error("expected run command");
        expect(opts).toMatchObject({ filter: "backend-*", quiet: true });
      },
    );

    it("keeps --quiet off the subcommands", () => {
      expect(() => parseArguments(["list", "--quiet"])).toThrow(/process\.exit/);
    });
  });

  describe("help text", () => {
    it("carries examples and a link to the docs", () => {
      expect(() => parseArguments(["--help"])).toThrow(/process\.exit/);
      const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");

      expect(output).toContain("Examples:");
      expect(output).toContain("sync-worktrees --run-once");
      expect(output).toContain("--restore <id>");
      expect(output).toContain("frontend-*");
      expect(output).toContain("https://github.com/yordan-kanchelov/sync-worktrees/tree/main/docs");
      expect(output).toContain("sync-worktrees completion");
    });
  });

  describe("shell completion", () => {
    it("prints a completion script", () => {
      expect(() => parseArguments(["completion"])).toThrow(/process\.exit\(0\)/);
      const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
      expect(output).toContain("--get-yargs-completions");
      expect(output).toContain("sync-worktrees");
    });

    it("completes the root command's flags at the top level", () => {
      expect(() => parseArguments(["--get-yargs-completions", "sync-worktrees", "--"])).toThrow(/process\.exit/);
      const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n").split("\n");
      expect(output).toEqual(expect.arrayContaining(["--run-once", "--filter", "--quiet", "--config"]));
      expect(output).not.toContain("--c");
    });

    it("completes a subcommand's own flags", () => {
      expect(() => parseArguments(["--get-yargs-completions", "sync-worktrees", "trash", "--"])).toThrow(
        /process\.exit/,
      );
      const output = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n").split("\n");
      expect(output).toEqual(expect.arrayContaining(["--restore", "--drop-keep-ref", "--drop-all-keep-refs"]));
      expect(output).not.toContain("--run-once");
      expect(output).not.toContain("--f");
    });
  });

  describe("unknown-argument suggestions", () => {
    const stderrOf = (): string => (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");

    it.each([
      ["lst", "sync-worktrees list"],
      ["tarsh", "sync-worktrees trash"],
      ["int", "sync-worktrees init"],
    ])("suggests a command for %s", (typo, suggestion) => {
      expect(() => parseArguments([typo])).toThrow(/process\.exit\(1\)/);
      expect(stderrOf()).toContain(`Did you mean '${suggestion}'?`);
    });

    it.each([
      ["--runonce", "--run-once"],
      ["--quite", "--quiet"],
      ["--filtr", "--filter"],
    ])("suggests a flag for %s", (typo, suggestion) => {
      expect(() => parseArguments([typo])).toThrow(/process\.exit\(1\)/);
      expect(stderrOf()).toContain(`Did you mean '${suggestion}'?`);
    });

    it("suggests a trash flag from its camelCase misspelling", () => {
      expect(() => parseArguments(["trash", "--dropKeepRefs", "x"])).toThrow(/process\.exit\(1\)/);
      expect(stderrOf()).toContain("Did you mean '--drop-keep-ref'?");
    });

    it("names a misplaced flag once, as typed, with no suggestion", () => {
      expect(() => parseArguments(["list", "--runOnce"])).toThrow(/process\.exit\(1\)/);
      const stderr = stderrOf();
      expect(stderr).toContain("Unknown argument: runOnce");
      expect(stderr).not.toContain("run-once");
      expect(stderr).not.toContain("Did you mean");
    });

    it("does not 'correct' a real command given in the wrong place", () => {
      expect(() => parseArguments(["trash", "list"])).toThrow(/process\.exit\(1\)/);
      expect(stderrOf()).toContain("Unknown argument: list");
      expect(stderrOf()).not.toContain("Did you mean");
    });

    it("stays silent when nothing is close", () => {
      expect(describeParseFailure("Unknown argument: xyzzy", ["xyzzy"])).toEqual(["Unknown argument: xyzzy"]);
      expect(describeParseFailure("Not enough arguments", [])).toEqual(["Not enough arguments"]);
    });
  });
});
