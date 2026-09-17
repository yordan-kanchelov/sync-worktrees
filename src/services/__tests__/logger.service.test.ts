import { describe, expect, it, vi } from "vitest";

import { Logger } from "../logger.service";

const TOKEN_URL = "https://ci-bot:s3cr3t-token@git.example.com/org/repo.git";
const REDACTED_URL = "https://***@git.example.com/org/repo.git";

// console.* are vi.fn() stubs (see src/__tests__/setup.ts), so every line the
// logger prints can be read back from their mock calls.
const printedLines = (): string[] =>
  [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ].map((call) => call.map(String).join(" "));

describe("Logger credential redaction", () => {
  it("scrubs credential-bearing URLs from info/warn/debug/table console output", () => {
    const logger = new Logger({ repoName: "repo", debug: true });

    logger.info(`Cloning from "${TOKEN_URL}" as bare repository...`);
    logger.warn(`Existing clone has origin '${TOKEN_URL}'`);
    logger.debug("remote is %s", TOKEN_URL);
    logger.table(`| ${TOKEN_URL} |`);

    expect(console.log).toHaveBeenCalledWith(`[repo] Cloning from "${REDACTED_URL}" as bare repository...`);
    expect(console.warn).toHaveBeenCalledWith(`[repo] Existing clone has origin '${REDACTED_URL}'`);
    expect(console.log).toHaveBeenCalledWith(`[repo] remote is ${REDACTED_URL}`);
    expect(console.log).toHaveBeenCalledWith(`\n| ${REDACTED_URL} |\n`);
    expect(printedLines().join("\n")).not.toContain("s3cr3t-token");
  });

  it("hands scrubbed lines to a custom outputFn (TUI and MCP stderr loggers)", () => {
    const outputFn = vi.fn();
    const logger = new Logger({ outputFn });

    logger.info(`URL: ${TOKEN_URL}`);
    logger.error("Sync failed:", new Error(`fatal: unable to access '${TOKEN_URL}/': 403`));

    expect(outputFn).toHaveBeenNthCalledWith(1, `URL: ${REDACTED_URL}`, "info");
    expect(outputFn).toHaveBeenNthCalledWith(
      2,
      `Sync failed: fatal: unable to access '${REDACTED_URL}/': 403`,
      "error",
    );
    expect(JSON.stringify(outputFn.mock.calls)).not.toContain("s3cr3t-token");
  });

  it("scrubs the inspected error (message, stack and simple-git task commands) on the console path", () => {
    const logger = new Logger();
    // simple-git errors carry the invoked command line, URL included, as an
    // enumerable `task` property that util.inspect prints alongside the stack.
    const error = Object.assign(new Error(`fatal: could not read from remote repository ${TOKEN_URL}`), {
      task: { commands: ["clone", TOKEN_URL, "--bare"] },
    });

    logger.error("❌ Failed to initialize repository:", error);

    expect(console.error).toHaveBeenCalledTimes(1);
    const call = vi.mocked(console.error).mock.calls[0];
    // The raw Error is never handed to console.error; only the scrubbed text is.
    expect(call).toHaveLength(1);
    const line = String(call[0]);
    expect(line).toContain(
      `❌ Failed to initialize repository: Error: fatal: could not read from remote repository ${REDACTED_URL}`,
    );
    expect(line).toContain("    at "); // the stack trace survives for diagnostics
    expect(line).toContain("commands");
    expect(line).toContain(`'${REDACTED_URL}'`);
    expect(line).not.toContain("s3cr3t-token");
  });

  it("scrubs string details and bare messages on the console path", () => {
    const logger = new Logger({ repoName: "repo" });

    logger.error("remote rejected", `see ${TOKEN_URL}`);
    logger.error(`unreachable: ${TOKEN_URL}`);

    expect(console.error).toHaveBeenNthCalledWith(1, `[repo] remote rejected see ${REDACTED_URL}`);
    expect(console.error).toHaveBeenNthCalledWith(2, `[repo] unreachable: ${REDACTED_URL}`);
  });

  it("scrubs lines forwarded through withPassthrough", () => {
    const passthrough = vi.fn();
    const logger = new Logger({ repoName: "repo" }).withPassthrough(passthrough);

    logger.warn(`origin '${TOKEN_URL}' is not 'https://github.com/org/repo.git'`);

    const expected = `[repo] origin '${REDACTED_URL}' is not 'https://github.com/org/repo.git'`;
    expect(console.warn).toHaveBeenCalledWith(expected);
    expect(passthrough).toHaveBeenCalledWith(expected, "warn");
  });

  it("leaves lines without credentials untouched", () => {
    const logger = new Logger({ repoName: "repo" });

    logger.info("Fetching origin/main from https://github.com/org/repo.git (git@github.com:org/repo.git)");
    logger.error("Sync failed:", new Error("network unreachable"));

    expect(console.log).toHaveBeenCalledWith(
      "[repo] Fetching origin/main from https://github.com/org/repo.git (git@github.com:org/repo.git)",
    );
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      "[repo] Sync failed: Error: network unreachable",
    );
  });
});
