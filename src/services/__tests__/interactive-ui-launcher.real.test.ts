import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InteractiveUIService } from "../InteractiveUIService";

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn(), waitUntilExit: () => new Promise<void>(() => {}), clear: vi.fn() })),
}));

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

  const writeEditor = (name: string, body: string): string => {
    const file = path.join(tmpDir, name);
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
        } catch {}
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
  });

  it("refuses a terminal editor without ever starting the program", async () => {
    const marker = path.join(tmpDir, "vim-ran");
    const editorDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-vimdir-"));
    const fake = path.join(editorDir, "vim");
    fs.writeFileSync(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    process.env.EDITOR = fake;
    delete process.env.VISUAL;

    const result = service.launcher.openEditorInWorktree(tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("terminal editor");
    expect(result.error).toContain("Terminal mode");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker), "the refused terminal editor was spawned anyway").toBe(false);
    expect(logs.some((entry) => entry.level === "error" && /terminal editor/.test(entry.message))).toBe(true);
    fs.rmSync(editorDir, { recursive: true, force: true });
  });

  it("refuses 'emacs -nw -g', where a GUI flag used to overrule the terminal one", async () => {
    const marker = path.join(tmpDir, "emacs-ran");
    const editorDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-emacsdir-"));
    const fake = path.join(editorDir, "emacs");
    fs.writeFileSync(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    process.env.EDITOR = `${JSON.stringify(fake)} -nw -g`;
    delete process.env.VISUAL;

    const result = service.launcher.openEditorInWorktree(tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("terminal editor");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker), "emacs -nw -g was spawned into the void anyway").toBe(false);
    fs.rmSync(editorDir, { recursive: true, force: true });
  });

  it("reports an unknown editor that dies on its own, which the basename list cannot catch", async () => {
    const editor = writeEditor("my-edit-wrapper", "exit 3");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    const result = service.launcher.openEditorInWorktree(tmpDir);
    expect(result.success).toBe(true);

    const entry = await waitForLog(/exited immediately with code 3/);
    expect(entry.level).toBe("error");
    expect(entry.message).toContain("Editor");
    expect(entry.message).toContain("nothing was opened");
    const hint = await waitForLog(/Check EDITOR\/VISUAL/);
    expect(hint.level).toBe("warn");
  });

  it.each([
    ["SEGV", "SIGSEGV"],
    ["ABRT", "SIGABRT"],
  ])("reports an editor killed by SIG%s, which delivers no exit code at all", async (signal, expected) => {
    const editor = writeEditor(`crash-on-${signal}`, `kill -${signal} $$`);
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    const result = service.launcher.openEditorInWorktree(tmpDir);
    expect(result.success).toBe(true);

    const entry = await waitForLog(new RegExp(`was killed by ${expected}`));
    expect(entry.level).toBe("error");
    expect(entry.message).toContain("Editor");
    expect(entry.message).toContain("nothing was opened");
    const hint = await waitForLog(/Check EDITOR\/VISUAL/);
    expect(hint.level).toBe("warn");
  });

  it("stays silent for an editor the user closes with a signal long after it opened", async () => {
    const editor = writeEditor("late-killed-editor", "sleep 6\nkill -TERM $$");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    expect(service.launcher.openEditorInWorktree(tmpDir).success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("stays silent for a GUI editor that is still running", async () => {
    const pidFile = path.join(tmpDir, "gui.pid");
    const editor = writeEditor("gui-editor", `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 30`);
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    const result = service.launcher.openEditorInWorktree(tmpDir);
    expect(result.success).toBe(true);

    await vi.waitFor(() => {
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, "utf8").trim().length).toBeGreaterThan(0);
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    spawnedPids.push(pid);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(pid), "the GUI editor should still be running").toBe(true);
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("stays silent for an editor that hands off to a running instance and exits 0", async () => {
    const editor = writeEditor("handoff-editor", "exit 0");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    expect(service.launcher.openEditorInWorktree(tmpDir).success).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("stays silent for an editor that ran for a while and then exited non-zero", async () => {
    const editor = writeEditor("late-failing-editor", "sleep 6\nexit 1");
    process.env.EDITOR = editor;
    delete process.env.VISUAL;

    expect(service.launcher.openEditorInWorktree(tmpDir).success).toBe(true);

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

    expect(service.launcher.openEditorInWorktree("/some/worktree").success).toBe(true);

    await vi.waitFor(() => {
      expect(fs.existsSync(marker)).toBe(true);
    });
    expect(fs.readFileSync(marker, "utf8")).toBe("/some/worktree");
  });

  it("reports a terminal launcher that exits immediately", async () => {
    const launcher = writeEditor("broken-term", "exit 7");
    process.env.SYNC_WORKTREES_TERMINAL = launcher;
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = service.launcher.openTerminalInWorktree(0, "/worktrees/x", "feat/x");
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
