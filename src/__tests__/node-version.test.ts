import * as path from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

interface NodeVersionModule {
  MIN_NODE_MAJOR: number;
  nodeVersionWarning(version: string, program: string): string | null;
}

// bin/ is plain JavaScript that ships as-is, so it is loaded by URL rather
// than through a typed import.
const modulePath = path.join(__dirname, "../../bin/node-version.js");
const { MIN_NODE_MAJOR, nodeVersionWarning } = (await import(pathToFileURL(modulePath).href)) as NodeVersionModule;

describe("bin/node-version.js", () => {
  it("checks the same floor that package.json engines declares", () => {
    expect(packageJson.engines.node).toBe(`>=${MIN_NODE_MAJOR}.0.0`);
  });

  it("warns below the floor, naming the program, the running version and the way out", () => {
    const warning = nodeVersionWarning("22.22.2", "sync-worktrees-mcp");

    expect(warning).toContain("sync-worktrees-mcp:");
    expect(warning).toContain(`Node.js ${MIN_NODE_MAJOR} or newer is required`);
    expect(warning).toContain("Node.js 22.22.2");
    expect(warning).toContain("sync-worktrees@5");
  });

  it.each(["24.0.0", "24.11.1", "25.0.0", "30.2.1"])("is silent on Node %s", (version) => {
    expect(nodeVersionWarning(version, "sync-worktrees")).toBeNull();
  });

  it("is silent when the version cannot be parsed rather than guessing", () => {
    expect(nodeVersionWarning("", "sync-worktrees")).toBeNull();
    expect(nodeVersionWarning("vX", "sync-worktrees")).toBeNull();
  });
});
