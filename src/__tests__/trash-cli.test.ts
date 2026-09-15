import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildRepositories: vi.fn(),
  input: vi.fn(),
  initialize: vi.fn(),
  listTrashEntries: vi.fn(),
  listKeepRefs: vi.fn(),
  restoreFromTrash: vi.fn(),
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
      deleteKeepRef: mocks.deleteKeepRef,
      deleteKeepRefs: mocks.deleteKeepRefs,
    };
  }),
}));

import { main } from "../index";

const originalArgv = process.argv;
const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ["node", "sync-worktrees", "trash", "--config", "/test/config.js", "--filter", "repo"];
  mocks.buildRepositories.mockResolvedValue({
    repositories: [{ name: "repo", repoUrl: "https://invalid.example/repo.git", worktreeDir: "/test/worktrees" }],
  });
  mocks.initialize.mockRejectedValue(new Error("remote unavailable"));
  mocks.listTrashEntries.mockResolvedValue({ entries: [], invalid: [] });
  mocks.listKeepRefs.mockResolvedValue([]);
  mocks.restoreFromTrash.mockResolvedValue({ id: "trash-entry", originalPath: "/test/worktrees/restored" });
  mocks.deleteKeepRefs.mockResolvedValue({ deleted: 0, retained: [], errors: [] });
  setTTY(false);
});

afterEach(() => {
  process.argv = originalArgv;
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

it("dispatches --restore locally without initialization", async () => {
  process.argv.push("--restore", "trash-entry");

  await expect(main()).resolves.toBeUndefined();

  expect(mocks.restoreFromTrash).toHaveBeenCalledWith("trash-entry");
  expect(mocks.serviceConfig).toHaveBeenCalledWith(expect.objectContaining({ name: "repo" }));
  expect(mocks.buildRepositories).toHaveBeenCalledWith("/test/config.js", { filter: "repo" });
  expect(mocks.initialize).not.toHaveBeenCalled();
});

it("rejects --dropKeepRef without an interactive TTY", async () => {
  process.argv.push("--dropKeepRef", "preserved-entry");

  await expect(main()).rejects.toThrow("requires an interactive TTY");

  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.deleteKeepRef).not.toHaveBeenCalled();
  expect(mocks.initialize).not.toHaveBeenCalled();
});

it("rejects --dropKeepRef when the typed confirmation does not match", async () => {
  process.argv.push("--dropKeepRef", "preserved-entry");
  setTTY(true);
  mocks.input.mockResolvedValue("wrong-entry");

  await expect(main()).rejects.toThrow("was not confirmed");

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
});

// Dropping keep refs one typed confirmation at a time does not scale: a
// squash-merging team accumulates one per pruned branch and they are only
// removable individually or by a force clean that also takes the whole trash.
it("rejects --dropAllKeepRefs without an interactive TTY", async () => {
  process.argv.push("--dropAllKeepRefs");
  mocks.listKeepRefs.mockResolvedValue(["refs/sync-worktrees/keep/a"]);

  await expect(main()).rejects.toThrow("requires an interactive TTY");

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

  await expect(main()).rejects.toThrow("was not confirmed");

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
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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

  expect(log.mock.calls.flat().join("\n")).toContain("refs/sync-worktrees/keep/a");
  expect(warn.mock.calls.flat().join("\n")).toContain("cannot lock ref");
  log.mockRestore();
  warn.mockRestore();
});
