import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import { parseArguments } from "../cli";

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
});
