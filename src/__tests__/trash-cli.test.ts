import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../constants";
import { TrashOperationError } from "../errors";

import type { TrashEntry, TrashManifest } from "../services/trash.service";

const mocks = vi.hoisted(() => ({
  buildRepositories: vi.fn(),
  input: vi.fn(),
  initialize: vi.fn(),
  listTrashEntries: vi.fn(),
  listKeepRefs: vi.fn(),
  restoreFromTrash: vi.fn(),
  purgeTrashEntry: vi.fn(),
  deleteKeepRef: vi.fn(),
  deleteKeepRefs: vi.fn(),
  serviceConfig: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({ input: mocks.input }));

vi.mock("../services/config-loader.service", () => ({
  ConfigLoaderService: vi.fn(function () {
    return { buildRepositories: mocks.buildRepositories };
  }),
}));

vi.mock("../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function (config) {
    mocks.serviceConfig(config);
    return {
      initialize: mocks.initialize,
      isInitialized: vi.fn(() => true),
      isCloneMode: vi.fn(() => false),
      listTrashEntries: mocks.listTrashEntries,
      listKeepRefs: mocks.listKeepRefs,
      restoreFromTrash: mocks.restoreFromTrash,
      purgeTrashEntry: mocks.purgeTrashEntry,
      deleteKeepRef: mocks.deleteKeepRef,
      deleteKeepRefs: mocks.deleteKeepRefs,
    };
  }),
}));

import { main } from "../index";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

const PIN_REF = "refs/sync-worktrees/trash/aabbccdd/2026-06-06T18-30-00-000Z-qqq-a1b2c3";

function makeEntry(overrides: Partial<TrashManifest> = {}): TrashEntry {
  const manifest: TrashManifest = {
    schemaVersion: 1,
    id: "2026-06-06T18-30-00-000Z-qqq-a1b2c3",
    deletedAt: "2026-06-06T18:30:00.000Z",
    expiresAt: "2026-07-06T18:30:00.000Z",
    originalPath: "/test/worktrees/feature-x",
    branch: "feature-x",
    reason: "prune",
    sizeBytes: null,
    headOid: "a".repeat(40),
    pinRef: PIN_REF,
    source: "worktree",
    legacyOriginalName: null,
    ...overrides,
  };
  return {
    manifest,
    containerPath: `/test/worktrees/.trash/${manifest.id}`,
    payloadPath: `/test/worktrees/.trash/${manifest.id}/payload`,
  };
}

/** Everything console.log received this test, joined — the CLI's stdout. */
function stdout(log: ReturnType<typeof vi.spyOn>): string {
  return (log.mock.calls as unknown[][]).map((call) => call.join(" ")).join("\n");
}

function stderr(error: ReturnType<typeof vi.spyOn>): string {
  return (error.mock.calls as unknown[][]).map((call) => call.join(" ")).join("\n");
}

let log: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let warnLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ["node", "sync-worktrees", "trash", "--config", "/test/config.js", "--filter", "repo"];
  process.exitCode = undefined;
  mocks.buildRepositories.mockResolvedValue({
    repositories: [{ name: "repo", repoUrl: "https://invalid.example/repo.git", worktreeDir: "/test/worktrees" }],
  });
  mocks.initialize.mockRejectedValue(new Error("remote unavailable"));
  mocks.listTrashEntries.mockResolvedValue({ entries: [], invalid: [] });
  mocks.listKeepRefs.mockResolvedValue([]);
  mocks.restoreFromTrash.mockResolvedValue({ id: "trash-entry", originalPath: "/test/worktrees/restored" });
  mocks.purgeTrashEntry.mockResolvedValue({ deleted: true, keepRefsMinted: [], errors: [] });
  mocks.deleteKeepRefs.mockResolvedValue({ deleted: 0, retained: [], errors: [] });
  setTTY(false);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  // The CLI reports expected failures with process.exitCode, so leaving it set
  // would fail the vitest run itself.
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  if (originalStdinTTY) Object.defineProperty(process.stdin, "isTTY", originalStdinTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalStdoutTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

it("lists local trash without initializing or contacting the remote", async () => {
  await expect(main()).resolves.toBeUndefined();

  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.listTrashEntries).toHaveBeenCalledOnce();
});

// The listing takes no repository lock, so it must not claim it will wait for
// one; the notice belongs to the two operations that do.
it("does not announce a lock wait for a listing", async () => {
  setTTY(true);
  process.argv.push("--wait");

  await expect(main()).resolves.toBeUndefined();

  expect(stdout(log)).not.toContain("Waiting up to");
  expect(stdout(log)).toContain("No trash entries");
});

// An empty trash used to print nothing at all, which is indistinguishable from
// a command that silently did not run.
// A pipe is not a person. cli-table3 draws box characters and ANSI colour with
// no terminal detection of its own, so rendering the table down a pipe would
// hand `sync-worktrees trash | cut -f1` escape sequences where it used to get
// an id. The rows this command has printed since 5.2.0 are what a script still
// gets, which is also why this change is not a breaking one.
it("keeps the tab-separated rows when stdout is not a terminal", async () => {
  setTTY(false);
  process.argv.push("--filter", "repo");
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/kept-one"]);

  await expect(main()).resolves.toBeUndefined();

  const out = stdout(log);
  expect(out).toContain("2026-06-06T18-30-00-000Z-qqq-a1b2c3\tprune\t");
  expect(out).toContain("\t/test/worktrees/feature-x");
  expect(out).toContain("KEEP\tkept-one");
  // No table, and above all no escape sequences for a pipe to swallow.
  expect(out).not.toContain("Keep on reap");
  // eslint-disable-next-line no-control-regex
  expect(out).not.toMatch(/\u001b\[/);
});

it("says the trash is empty rather than printing nothing", async () => {
  setTTY(true);
  await expect(main()).resolves.toBeUndefined();

  expect(stdout(log)).toContain("No trash entries");
  expect(process.exitCode).toBeUndefined();
});

it("renders one row per entry with branch, reason, size, restorability and the keep marker", async () => {
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({
    entries: [
      makeEntry({ keepPinOnReap: true }),
      // No branch, no pin: an orphaned directory. Its original path is the only
      // thing that identifies it, so the row has to fall back to that.
      // The id deliberately shares no substring with the directory name or the
      // reason: an id that spelled either would satisfy the row assertions
      // below without the columns ever being rendered.
      makeEntry({
        id: "2026-06-06T18-31-00-000Z-qqq-ffeedd",
        branch: null,
        headOid: null,
        pinRef: null,
        reason: "orphan",
        originalPath: "/test/worktrees/left-behind",
        sizeBytes: 2048,
      }),
    ],
    invalid: [],
  });
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/older-entry"]);

  await expect(main()).resolves.toBeUndefined();

  const out = stdout(log);
  expect(out).toContain("Keep on reap");

  const pruned = out.split("\n").filter((line) => line.includes("2026-06-06T18-30-00-000Z-qqq-a1b2c3"));
  expect(pruned).toHaveLength(1);
  expect(pruned[0]).toContain("feature-x");
  expect(pruned[0]).toContain("prune");
  expect(pruned[0]).toContain("worktree");
  expect(pruned[0]).toContain("2026-07-06");
  // The keep-on-reap marker: these commits were on no remote when the worktree
  // was pruned, which is what a reap turns into a permanent ref.
  expect(pruned[0]).toContain("yes");

  const orphaned = out.split("\n").filter((line) => line.includes("2026-06-06T18-31-00-000Z-qqq-ffeedd"));
  expect(orphaned).toHaveLength(1);
  // No branch to name, so the row falls back to the directory it came from,
  // relative to worktreeDir.
  expect(orphaned[0]).toContain("left-behind");
  expect(orphaned[0]).not.toContain("/test/worktrees/left-behind");
  expect(orphaned[0]).toContain("orphan");
  expect(orphaned[0]).toContain("files only");
  expect(orphaned[0]).toContain("2.00 KB");
  // The marker is per entry, not a legend printed for the whole table.
  expect(orphaned[0]).not.toContain("yes");

  // Short name, not the full ref: it is what --dropKeepRef takes.
  expect(out).toContain("older-entry");
});

// Sizes are measured off the repository lock, so an entry trashed moments ago
// is genuinely unmeasured. Printing "0 B" for it would say the opposite of the
// truth about what deleting it frees.
it("renders an unmeasured size as unknown, never as zero", async () => {
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({
    entries: [makeEntry({ sizeBytes: null }), makeEntry({ id: "measured-entry", sizeBytes: 4096 })],
    invalid: [],
  });

  await expect(main()).resolves.toBeUndefined();

  const out = stdout(log);
  // Both rows are actually on screen — otherwise the "no zero" assertion below
  // would hold for a listing that printed nothing.
  expect(out).toContain("2026-06-06T18-30-00-000Z-qqq-a1b2c3");
  expect(out).toContain("measured-entry");
  expect(out).toContain("4.00 KB");
  expect(out).toContain("—");
  expect(out).not.toContain("0 B");
});

// An entry past its expiry is still on disk — the reaper only runs at the tail
// of a sync — so the listing has to say which ones are only waiting for that.
it("marks an entry whose expiry has already passed", async () => {
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({
    entries: [
      makeEntry({ id: "overdue-entry", expiresAt: "2020-01-02T00:00:00.000Z" }),
      makeEntry({ id: "current-entry", expiresAt: "2999-01-02T00:00:00.000Z" }),
    ],
    invalid: [],
  });

  await expect(main()).resolves.toBeUndefined();

  const lines = stdout(log).split("\n");
  expect(lines.filter((line) => line.includes("overdue-entry"))[0]).toContain("2020-01-02 (expired)");
  expect(lines.filter((line) => line.includes("current-entry"))[0]).not.toContain("expired");
});

it("still reports entries whose manifest cannot be read", async () => {
  mocks.listTrashEntries.mockResolvedValue({ entries: [], invalid: ["/test/worktrees/.trash/not-a-manifest"] });

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(warnLog)).toContain("/test/worktrees/.trash/not-a-manifest");
});

it("emits parseable JSON that keeps an unmeasured size null", async () => {
  process.argv.push("--json");
  mocks.listTrashEntries.mockResolvedValue({
    entries: [
      makeEntry({ keepPinOnReap: true }),
      makeEntry({ id: "files-only-entry", branch: null, headOid: null, pinRef: null, sizeBytes: 0 }),
    ],
    invalid: ["/test/worktrees/.trash/broken"],
  });
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/older-entry"]);

  await expect(main()).resolves.toBeUndefined();

  const parsed = JSON.parse(stdout(log)) as {
    entries: Array<{
      id: string;
      sizeBytes: number | null;
      restoresAsWorktree: boolean;
      keepPinOnReap: boolean;
      branch: string | null;
      originalPath: string;
    }>;
    invalidEntries: string[];
    keepRefs: string[];
  };

  expect(parsed.entries).toHaveLength(2);
  expect(parsed.entries[0].id).toBe("2026-06-06T18-30-00-000Z-qqq-a1b2c3");
  // null, not 0 — the two mean opposite things and JSON can tell them apart.
  expect(parsed.entries[0].sizeBytes).toBeNull();
  expect(parsed.entries[1].sizeBytes).toBe(0);
  expect(parsed.entries[0].restoresAsWorktree).toBe(true);
  expect(parsed.entries[0].keepPinOnReap).toBe(true);
  expect(parsed.entries[1].restoresAsWorktree).toBe(false);
  expect(parsed.entries[1].keepPinOnReap).toBe(false);
  expect(parsed.entries[0].originalPath).toBe("/test/worktrees/feature-x");
  expect(parsed.invalidEntries).toEqual(["/test/worktrees/.trash/broken"]);
  expect(parsed.keepRefs).toEqual(["older-entry"]);
});

it("dispatches --restore locally without initialization", async () => {
  process.argv.push("--restore", "trash-entry");

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.restoreFromTrash).toHaveBeenCalledWith("trash-entry", { lockWaitMs: undefined });
  expect(mocks.serviceConfig).toHaveBeenCalledWith(expect.objectContaining({ name: "repo" }));
  expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/config.js", { filter: "repo" });
  expect(mocks.initialize).not.toHaveBeenCalled();
});

// The cross-process lock used to fail on the spot, so a restore attempted while
// a daemon was mid-sync lost for a reason that clears itself in a minute.
it("gives --restore a bounded lock budget under --wait", async () => {
  process.argv.push("--restore", "trash-entry", "--wait");

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.restoreFromTrash).toHaveBeenCalledWith("trash-entry", { lockWaitMs: DEFAULT_CONFIG.LOCK_WAIT_MS });
  // A budget, not "block until it frees up": a scripted run terminates, and the
  // person is told how long it will wait before it starts waiting.
  expect(DEFAULT_CONFIG.LOCK_WAIT_MS).toBeLessThanOrEqual(600_000);
  expect(stdout(log)).toContain("Waiting up to 120s");
});

// A rejected restore is an ordinary outcome — a wrong id, an occupied
// destination, a lock somebody else holds — and used to reach main().catch as
// "❌ Unhandled error:" plus a stack.
it("reports a rejected restore as one line with exit code 1 and no stack", async () => {
  process.argv.push("--restore", "trash-entry");
  mocks.restoreFromTrash.mockRejectedValue(
    new TrashOperationError("restore", "destination '/test/worktrees/feature-x' already exists"),
  );

  await expect(main()).resolves.toBeUndefined();

  expect(errorLog).toHaveBeenCalledTimes(1);
  const line = String(errorLog.mock.calls[0][0]);
  expect(line).toContain("❌");
  expect(line).toContain("already exists");
  expect(line).not.toContain("Unhandled error");
  expect(line).not.toMatch(/\n\s+at /);
  expect(process.exitCode).toBe(1);
});

it("reports a lock another process holds as one line, not a crash", async () => {
  process.argv.push("--restore", "trash-entry");
  mocks.restoreFromTrash.mockRejectedValue(
    new TrashOperationError("restore", "cannot restore trash entry: another process holds the repository lock"),
  );

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("another process holds the repository lock");
  expect(process.exitCode).toBe(1);
});

// The counterpart: the catch is narrow on purpose. A bug has nothing useful to
// say in one line, so it keeps its stack and reaches main().catch.
it("lets an unexpected failure keep its stack", async () => {
  process.argv.push("--restore", "trash-entry");
  mocks.restoreFromTrash.mockRejectedValue(new TypeError("service.restore is not a function"));

  await expect(main()).rejects.toBeInstanceOf(TypeError);

  expect(process.exitCode).toBeUndefined();
});

it("rejects --dropKeepRef without an interactive TTY", async () => {
  process.argv.push("--dropKeepRef", "preserved-entry");

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("requires an interactive TTY");
  expect(process.exitCode).toBe(1);
  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.deleteKeepRef).not.toHaveBeenCalled();
  expect(mocks.initialize).not.toHaveBeenCalled();
});

// Ctrl+C at a confirmation prompt is how a destructive command is declined,
// and @inquirer answers it with an ExitPromptError of its own rather than
// letting the signal through — so it landed in main().catch as "❌ Unhandled
// error:" followed by ten frames of readline internals. Verified against the
// real prompt under a pty; the name and message here are the ones it produced.
it("reports Ctrl+C at a confirmation prompt as one line, not a crash", async () => {
  process.argv.push("--dropKeepRef", "preserved-entry");
  setTTY(true);
  const cancelled = new Error("User force closed the prompt with SIGINT");
  cancelled.name = "ExitPromptError";
  mocks.input.mockRejectedValue(cancelled);

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("SIGINT");
  expect(stderr(errorLog)).not.toContain("Unhandled error");
  expect(stderr(errorLog)).not.toMatch(/\n\s+at /);
  expect(mocks.deleteKeepRef).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("rejects --dropKeepRef when the typed confirmation does not match", async () => {
  process.argv.push("--dropKeepRef", "preserved-entry");
  setTTY(true);
  mocks.input.mockResolvedValue("wrong-entry");

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("was not confirmed");
  expect(process.exitCode).toBe(1);
  expect(mocks.deleteKeepRef).not.toHaveBeenCalled();
});

it("dispatches --dropKeepRef after exact typed TTY confirmation", async () => {
  process.argv.push("--dropKeepRef", "preserved-entry");
  setTTY(true);
  mocks.input.mockResolvedValue("preserved-entry");

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.input).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("preserved-entry") }),
  );
  expect(mocks.deleteKeepRef).toHaveBeenCalledWith("preserved-entry");
  expect(mocks.serviceConfig).toHaveBeenCalledWith(expect.objectContaining({ name: "repo" }));
  expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/config.js", { filter: "repo" });
  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

// Dropping keep refs one typed confirmation at a time does not scale: a
// squash-merging team accumulates one per pruned branch and they are only
// removable individually or by a force clean that also takes the whole trash.
it("rejects --dropAllKeepRefs without an interactive TTY", async () => {
  process.argv.push("--dropAllKeepRefs");
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/a"]);

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("requires an interactive TTY");
  expect(process.exitCode).toBe(1);
  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.deleteKeepRefs).not.toHaveBeenCalled();
});

it("does not prompt when there is nothing to drop", async () => {
  process.argv.push("--dropAllKeepRefs");
  setTTY(true);
  mocks.listKeepRefs.mockResolvedValue([]);

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.deleteKeepRefs).not.toHaveBeenCalled();
});

it("rejects --dropAllKeepRefs when the typed confirmation does not match", async () => {
  process.argv.push("--dropAllKeepRefs");
  setTTY(true);
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/a", "refs/sync-worktrees/keep/b"]);
  mocks.input.mockResolvedValue("drop");

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("was not confirmed");
  expect(process.exitCode).toBe(1);
  expect(mocks.deleteKeepRefs).not.toHaveBeenCalled();
});

it("drops exactly the refs the confirmation counted, after one typed answer", async () => {
  process.argv.push("--dropAllKeepRefs");
  setTTY(true);
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/a", "refs/sync-worktrees/keep/b"]);
  mocks.input.mockResolvedValue("drop 2");
  mocks.deleteKeepRefs.mockResolvedValue({ deleted: 2, retained: [], errors: [] });

  await expect(main()).resolves.toBeUndefined();

  // One confirmation for the whole batch, and it names the count the typed
  // phrase has to match.
  expect(mocks.input).toHaveBeenCalledTimes(1);
  expect(mocks.input).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("drop 2") }));
  // The only warning on an irreversible, destructive prompt. Without this the
  // message could be reduced to the typed phrase alone and nothing would notice.
  const prompt = String(mocks.input.mock.calls[0][0].message);
  expect(prompt).toContain("git gc");
  expect(prompt).toContain("cannot be undone");
  // Names, not "everything present when the lock is finally held": the listing
  // above is what the person was shown.
  expect(mocks.deleteKeepRefs).toHaveBeenCalledWith(["a", "b"]);
  expect(mocks.deleteKeepRef).not.toHaveBeenCalled();
  expect(mocks.initialize).not.toHaveBeenCalled();
});

it("reports retained and failed refs from a batch drop", async () => {
  process.argv.push("--dropAllKeepRefs");
  setTTY(true);
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/a", "refs/sync-worktrees/keep/b"]);
  mocks.input.mockResolvedValue("drop 2");
  mocks.deleteKeepRefs.mockResolvedValue({
    deleted: 0,
    retained: ["refs/sync-worktrees/keep/a"],
    errors: ["refs/sync-worktrees/keep/b: cannot lock ref"],
  });

  await expect(main()).resolves.toBeUndefined();

  expect(stdout(log)).toContain("refs/sync-worktrees/keep/a");
  expect(stderr(warnLog)).toContain("cannot lock ref");
});

// --purge is a data-loss path, so it carries the same gate as --dropKeepRef and
// --dropAllKeepRefs: an interactive TTY and a typed confirmation.
// The gate is `!stdin.isTTY || !stdout.isTTY`, and every other test here sets
// both halves together — so an `&&` typo would pass all of them. A purge run
// as `sync-worktrees trash --purge <id> < /dev/null` from a terminal has a TTY
// stdout and a redirected stdin, and must still refuse.
it("refuses a purge when stdin is redirected even though stdout is a terminal", async () => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  // The entry has to exist, or the refusal comes from "no trash entry with id"
  // and the test passes whatever the gate does.
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });
  process.argv.push("--filter", "repo", "--purge", "2026-06-06T18-30-00-000Z-qqq-a1b2c3");

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.purgeTrashEntry).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("rejects --purge without an interactive TTY", async () => {
  process.argv.push("--purge", "2026-06-06T18-30-00-000Z-qqq-a1b2c3");
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("requires an interactive TTY");
  expect(process.exitCode).toBe(1);
  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.purgeTrashEntry).not.toHaveBeenCalled();
});

it("rejects --purge when the typed confirmation is not the entry id", async () => {
  process.argv.push("--purge", "2026-06-06T18-30-00-000Z-qqq-a1b2c3");
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });
  mocks.input.mockResolvedValue("yes");

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("was not confirmed");
  expect(process.exitCode).toBe(1);
  expect(mocks.purgeTrashEntry).not.toHaveBeenCalled();
});

it("never prompts for --purge of an id that is not there", async () => {
  process.argv.push("--purge", "no-such-entry");
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.purgeTrashEntry).not.toHaveBeenCalled();
  expect(stderr(errorLog)).toContain("no-such-entry");
  expect(process.exitCode).toBe(1);
});

// A keep-on-reap entry's commits reached no remote, so its payload and pin can
// be the only copy. The prompt has to say the permanent ref is minted first,
// and the result has to say where the commits ended up.
it("names the permanent keep ref in the --purge prompt and in the result", async () => {
  const id = "2026-06-06T18-30-00-000Z-qqq-a1b2c3";
  process.argv.push("--purge", id);
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry({ keepPinOnReap: true })], invalid: [] });
  mocks.input.mockResolvedValue(id);
  mocks.purgeTrashEntry.mockResolvedValue({
    deleted: true,
    keepRefsMinted: [`refs/sync-worktrees/keep/${id}`],
    errors: [],
  });

  await expect(main()).resolves.toBeUndefined();

  const prompt = String(mocks.input.mock.calls[0][0].message);
  expect(prompt).toContain("cannot be undone");
  expect(prompt).toContain(`refs/sync-worktrees/keep/${id}`);
  expect(prompt).toContain(id);
  expect(mocks.purgeTrashEntry).toHaveBeenCalledWith(id, { lockWaitMs: undefined });

  const out = stdout(log);
  expect(out).toContain(`Purged ${id}`);
  expect(out).toContain(`refs/sync-worktrees/keep/${id}`);
  // The recovery instruction is only useful with the commit it names.
  expect(out).toContain("a".repeat(40));
  expect(process.exitCode).toBeUndefined();
});

it("does not promise a keep ref for an entry that has none", async () => {
  const id = "2026-06-06T18-30-00-000Z-qqq-a1b2c3";
  process.argv.push("--purge", id);
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });
  mocks.input.mockResolvedValue(id);

  await expect(main()).resolves.toBeUndefined();

  expect(String(mocks.input.mock.calls[0][0].message)).not.toContain("refs/sync-worktrees/keep/");
  expect(mocks.purgeTrashEntry).toHaveBeenCalledWith(id, { lockWaitMs: undefined });
});

it("gives --purge a bounded lock budget under --wait", async () => {
  const id = "2026-06-06T18-30-00-000Z-qqq-a1b2c3";
  process.argv.push("--purge", id, "--wait");
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });
  mocks.input.mockResolvedValue(id);

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.purgeTrashEntry).toHaveBeenCalledWith(id, { lockWaitMs: DEFAULT_CONFIG.LOCK_WAIT_MS });
});

// A refused delete leaves the entry listed and retryable, which is a failure of
// the command even though nothing crashed.
it("fails when the purge left the entry in place", async () => {
  const id = "2026-06-06T18-30-00-000Z-qqq-a1b2c3";
  process.argv.push("--purge", id);
  setTTY(true);
  mocks.listTrashEntries.mockResolvedValue({ entries: [makeEntry()], invalid: [] });
  mocks.input.mockResolvedValue(id);
  mocks.purgeTrashEntry.mockResolvedValue({
    deleted: false,
    keepRefsMinted: [],
    errors: [`${id}: cannot delete the payload of '/test/worktrees/.trash/${id}': EACCES`],
  });

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("EACCES");
  expect(stdout(log)).not.toContain("Purged");
  expect(process.exitCode).toBe(1);
});

// `list` and the sync command already answered a bad config with one line;
// `trash` was the only one that answered it with a stack.
it("reports a config that will not load as one line", async () => {
  mocks.buildRepositories.mockRejectedValue(
    new Error("Failed to load config file: Repository 'demo' must have a 'repoUrl' property"),
  );

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("must have a 'repoUrl' property");
  expect(stderr(errorLog)).not.toContain("Unhandled error");
  expect(process.exitCode).toBe(1);
});

it("reports a config that matches more than one repository as a usage error", async () => {
  mocks.buildRepositories.mockResolvedValue({
    repositories: [
      { name: "a", repoUrl: "https://invalid.example/a.git", worktreeDir: "/test/a" },
      { name: "b", repoUrl: "https://invalid.example/b.git", worktreeDir: "/test/b" },
    ],
  });

  await expect(main()).resolves.toBeUndefined();

  expect(stderr(errorLog)).toContain("exactly one repository");
  expect(process.exitCode).toBe(1);
});
