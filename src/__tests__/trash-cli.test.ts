import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildRepositories: vi.fn(),
  input: vi.fn(),
  initialize: vi.fn(),
  listTrashEntries: vi.fn(),
  listKeepRefs: vi.fn(),
  restoreFromTrash: vi.fn(),
  deleteKeepRef: vi.fn(),
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
