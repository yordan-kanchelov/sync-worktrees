import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InteractiveUIService } from "../InteractiveUIService";

// Only Ink is stubbed, and only because the constructor renders: the shared setup file swaps
// global.console for a plain object with no Console constructor, which real Ink rendering
// needs. child_process is untouched, which is the whole point of this file.
vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn(), waitUntilExit: () => new Promise<void>(() => {}), clear: vi.fn() })),
}));

// This file deliberately does NOT mock child_process. The sibling suite pins the argv the
// launcher builds, which proves what we asked for and nothing about what ran; here every
// editor is a real executable and the assertions are about the process that resulted.

// "Gone" has two shapes and only one is an ESRCH: an orphan reparented to pid 1 stays in the
// process table as a zombie until something reaps it, which this container does not do, so
// kill(pid, 0) keeps succeeding for a process that stopped long ago. Read the state instead.
const PROC_AVAILABLE = fs.existsSync("/proc/self/stat");

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!PROC_AVAILABLE) return true;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
};

const makeSyncService = (): any => ({
  sync: vi.fn(),
  initialize: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
  isSyncInProgress: vi.fn().mockReturnValue(false),
  updateLogger: vi.fn(),
  onProgress: vi.fn().mockReturnValue(vi.fn()),
  getRecordedSkips: vi.fn().mockReturnValue([]),
  clearRecordedSkips: vi.fn(),
  config: { name: "repo", worktreeDir: "/repo", repoUrl: "u" },
});

describe("editor launching against real processes", () => {
  let tmpDir: string;
  let service: InteractiveUIService;
  let logs: Array<{ message: string; level: string }>;
  const originalEditor = process.env.EDITOR;
  const originalVisual = process.env.VISUAL;
  const spawnedPids: number[] = [];

  /** Writes an executable stand-in editor and returns its absolute path. */
  const writeEditor = (name: string, body: string): string => {
    const file = path.join(tmpDir, name);
    // Recording the pid is the script's first act, so afterEach can kill it even when the test
    // never learns the pid -- an assertion that throws before the pid is read used to leave the
    // process untracked, and pid 1 does not reap here.
    fs.writeFileSync(file, `#!/bin/sh\necho $$ > ${JSON.stringify(`${file}.pid`)}\n${body}\n`, { mode: 0o755 });
    return file;
  };

  const waitForLog = async (pattern: RegExp): Promise<{ message: string; level: string }> => {
    let found: { message: string; level: string } | undefined;
    await vi.waitFor(
      () => {
        found = logs.find((entry) => pattern.test(entry.message));
        expect(found, `no log matched ${pattern} — saw ${JSON.stringify(logs)}`).toBeDefined();
      },
      { timeout: 15000, interval: 50 },
    );
    return found!;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-launcher-"));
    logs = [];
    service = new InteractiveUIService([makeSyncService()]);
    service.getEvents().on("addLog", (entry: { message: string; level: string }) => void logs.push(entry));
    service.getEvents().emit("uiReady");
  });

  afterEach(async () => {
    await service.destroy();
    // Leave nothing reparented to pid 1 behind: the pids a test recorded, every pid a stand-in
    // wrote down, and the process groups they lead. The launcher spawns detached, so each child
    // is its own group leader and anything it started (a script's `sleep`) is killed with it.
    const pids = new Set<number>(spawnedPids.splice(0));
    for (const entry of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []) {
      if (!entry.endsWith(".pid")) continue;
      const pid = Number(fs.readFileSync(path.join(tmpDir, entry), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
  });

  it("refuses a terminal editor without ever starting the program", async () => {
    // Named `vim` so detection fires, but it is really a tripwire: if the refusal ever
    // regresses into a spawn, the marker file appears and this test says so.
    const marker = path.join(tmpDir, "vim-ran");
    const editorDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-vimdir-"));
    const fake = path.join(editorDir, "vim");
    fs.writeFileSync(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    process.env.EDITOR = fake;
    delete process.env.VISUAL;

    const result = service.openEditorInWorktree(tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("terminal editor");
    expect(result.error).toContain("Terminal mode");
    // Give a spawn every chance to land before declaring it never happened.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker), "the refused terminal editor was spawned anyway").toBe(false);
    expect(logs.some((entry) => entry.level === "error" && /terminal editor/.test(entry.message))).toBe(true);
    fs.rmSync(editorDir, { recursive: true, force: true });
  });

  it("refuses 'emacs -nw -g', where a GUI flag used to overrule the terminal one", async () => {
    // The same tripwire as above, for the case a blanket GUI-flag list got wrong: measured
    // against this stand-in, `emacs -nw -g` reached execve with both flags on the line.
    const marker = path.join(tmpDir, "emacs-ran");
    const editorDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-emacsdir-"));
    const fake = path.join(editorDir, "emacs");
    fs.writeFileSync(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    process.env.EDITOR = `${JSON.stringify(fake)} -nw -g`;
    delete process.env.VISUAL;

    const result = service.openEditorInWorktree(tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("terminal editor");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker), "emacs -nw -g was spawned into the void anyway").toBe(false);
    fs.rmSync(editorDir, { recursive: true, force: true });
  });

  it("reports an unknown editor that dies on its own, which the basename list cannot catch", async () => {
    // A wrapper script is exactly where the heuristic fails open: nothing about the name
    // `my-edit-wrapper` says terminal editor, so it is spawned — and then it exits non-zero
    // like a real TTY-less vim does, and the exit code is what tells the user.
    const editor = writeEditor("my-edit-wrapper", "exit 3");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    const result = service.openEditorInWorktree(tmpDir);
    expect(result.success).toBe(true);

    const entry = await waitForLog(/exited immediately with code 3/);
    expect(entry.level).toBe("error");
    expect(entry.message).toContain("Editor");
    expect(entry.message).toContain("nothing was opened");
    const hint = await waitForLog(/Check EDITOR\/VISUAL/);
    expect(hint.level).toBe("warn");
  });

  // A child killed by a signal delivers code null with signalCode set, so a code-only guard
  // lets it through in silence -- while openEditorInWorktree has already returned
  // { success: true }. A GUI editor that segfaults on launch is exactly the silent failure this
  // file exists to catch, and it arrives within a few milliseconds.
  it.each([
    ["SEGV", "SIGSEGV"],
    ["ABRT", "SIGABRT"],
  ])("reports an editor killed by SIG%s, which delivers no exit code at all", async (signal, expected) => {
    const editor = writeEditor(`crash-on-${signal}`, `kill -${signal} $$`);
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    const result = service.openEditorInWorktree(tmpDir);
    expect(result.success).toBe(true);

    const entry = await waitForLog(new RegExp(`was killed by ${expected}`));
    expect(entry.level).toBe("error");
    expect(entry.message).toContain("Editor");
    expect(entry.message).toContain("nothing was opened");
    const hint = await waitForLog(/Check EDITOR\/VISUAL/);
    expect(hint.level).toBe("warn");
  });

  it("stays silent for an editor the user closes with a signal long after it opened", async () => {
    // Killed, but not on launch: it ran past the window, so this is the user closing a window
    // and not a launcher that never drew one.
    const editor = writeEditor("late-killed-editor", "sleep 6\nkill -TERM $$");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    expect(service.openEditorInWorktree(tmpDir).success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("stays silent for a GUI editor that is still running", async () => {
    const pidFile = path.join(tmpDir, "gui.pid");
    const editor = writeEditor("gui-editor", `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 30`);
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    const result = service.openEditorInWorktree(tmpDir);
    expect(result.success).toBe(true);

    await vi.waitFor(() => {
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, "utf8").trim().length).toBeGreaterThan(0);
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    spawnedPids.push(pid);

    // The point of detached + stdio "ignore": a GUI editor outlives the wizard. Prove it is
    // genuinely running rather than a zombie, and that nothing was reported about it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(pid), "the GUI editor should still be running").toBe(true);
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("stays silent for an editor that hands off to a running instance and exits 0", async () => {
    // `code <path>` returns straight away with status 0 when an instance is already open.
    // Exiting fast is therefore not evidence of failure; only a non-zero status is.
    const editor = writeEditor("handoff-editor", "exit 0");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    expect(service.openEditorInWorktree(tmpDir).success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("stays silent for an editor that ran for a while and then exited non-zero", async () => {
    // Opened fine, the user worked in it, and it fell over later. That is the editor's
    // business, not a launch failure, and calling it one would be crying wolf.
    const editor = writeEditor("late-failing-editor", "sleep 6\nexit 1");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    expect(service.openEditorInWorktree(tmpDir).success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("runs a GUI editor whose path contains spaces", async () => {
    const dirWithSpace = path.join(tmpDir, "My Editors");
    fs.mkdirSync(dirWithSpace);
    const marker = path.join(tmpDir, "spaced-ran");
    const editor = path.join(dirWithSpace, "my editor");
    fs.writeFileSync(editor, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    process.env.EDITOR = `"${editor}"`;
    delete process.env.VISUAL;

    expect(service.openEditorInWorktree("/some/worktree").success).toBe(true);

    await vi.waitFor(() => {
      expect(fs.existsSync(marker)).toBe(true);
    });
    // The whole quoted path reached execve as one argv entry, and the worktree came through
    // as the next one rather than being shifted along by the split-up path.
    expect(fs.readFileSync(marker, "utf8")).toBe("/some/worktree");
  });

  it("reports a terminal launcher that exits immediately", async () => {
    const launcher = writeEditor("broken-term", "exit 7");
    process.env.SYNC_WORKTREES_TERMINAL = launcher;
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = service.openTerminalInWorktree(0, "/worktrees/x", "feat/x");
      expect(result.success).toBe(true);

      const entry = await waitForLog(/exited immediately with code 7/);
      expect(entry.level).toBe("error");
      expect(entry.message).toContain("Terminal");
      const hint = await waitForLog(/Check SYNC_WORKTREES_TERMINAL/);
      expect(hint.level).toBe("warn");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      delete process.env.SYNC_WORKTREES_TERMINAL;
    }
  });
});
