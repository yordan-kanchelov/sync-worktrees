import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
