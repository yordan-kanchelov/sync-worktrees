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
    expect(opts.command).toBe("run");
    expect(opts.config).toBeUndefined();
  });

  it("parses --config", () => {
    const opts = parseArguments(["--config", "/etc/sync.config.js"]);
    expect(opts.command).toBe("run");
    expect(opts.config).toBe("/etc/sync.config.js");
  });

  it("parses init subcommand", () => {
    const opts = parseArguments(["init"]);
    expect(opts.command).toBe("init");
    expect(opts.config).toBeUndefined();
    expect(opts.force).toBe(false);
  });

  it("parses init --config <path> --force", () => {
    const opts = parseArguments(["init", "--config", "/tmp/new.config.js", "--force"]);
    expect(opts.command).toBe("init");
    expect(opts.config).toBe("/tmp/new.config.js");
    expect(opts.force).toBe(true);
  });

  it("parses list subcommand with --config + --filter", () => {
    const opts = parseArguments(["list", "--config", "/etc/sync.config.js", "--filter", "backend-*"]);
    expect(opts.command).toBe("list");
    expect(opts.config).toBe("/etc/sync.config.js");
    expect(opts.filter).toBe("backend-*");
  });
});
