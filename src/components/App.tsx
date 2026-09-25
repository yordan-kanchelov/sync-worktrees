import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, useInput, useWindowSize } from "ink";
import StatusBar from "./StatusBar";
import HelpModal from "./HelpModal";
import BranchCreationWizard from "./BranchCreationWizard";
import OpenEditorWizard from "./OpenEditorWizard";
import WorktreeStatusView from "./WorktreeStatusView";
import ForceCleanModal from "./ForceCleanModal";
import LogPanel from "./LogPanel";
import { redactSecretsInText } from "../utils/git-url";
import { isMouseSequence } from "../utils/mouse";
import type { AppEventEmitter } from "../utils/app-events";
import type { AppSyncProgress, CronScheduleDisplay, LastSyncOutcome } from "../utils/app-events";
import type {
  HookContext,
  WorktreeStatusEntry,
  DivergedDirectoryInfo,
  RepositoryListEntry,
  RepositoryDiskUsage,
  ForceCleanRepositoryPreview,
  ForceCleanRepositoryResult,
  ForceCleanRepositorySelection,
} from "../types";

export type { HookContext, WorktreeStatusEntry };

export interface AppProps {
  events: AppEventEmitter;
  repositoryCount: number;
  cronSchedule?: CronScheduleDisplay;
  onManualSync: () => void | Promise<void>;
  onReload: () => void | Promise<void>;
  onQuit: () => Promise<void>;
  maxProgressLines?: number;
  getRepositoryList: () => RepositoryListEntry[];
  getRepositoryDiskUsage?: (index: number) => Promise<RepositoryDiskUsage>;
  getBranchesForRepo: (index: number) => Promise<string[]>;
  getDefaultBranchForRepo: (index: number) => Promise<string>;
  fetchForRepo?: (index: number) => Promise<void>;
  createAndPushBranch: (
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ) => Promise<{ success: boolean; finalName: string; error?: string }>;
  getWorktreesForRepo: (index: number) => Promise<Array<{ path: string; branch: string }>>;
  openEditorInWorktree: (worktreePath: string) => { success: boolean; error?: string };
  openTerminalInWorktree: (
    repoIndex: number,
    worktreePath: string,
    branchName: string,
  ) => { success: boolean; error?: string };
  copyBranchFiles?: (repoIndex: number, baseBranch: string, targetBranch: string) => Promise<void>;
  createWorktreeForBranch: (repoIndex: number, branchName: string) => Promise<void>;
  executeOnBranchCreatedHooks?: (repoIndex: number, context: HookContext) => void;
  getWorktreeStatusForRepo?: (index: number) => Promise<WorktreeStatusEntry[]>;
  getDivergedDirectoriesForRepo?: (index: number) => Promise<DivergedDirectoryInfo[]>;
  deleteDivergedDirectory?: (repoIndex: number, name: string) => Promise<void>;
  getForceCleanPreview?: () => Promise<ForceCleanRepositoryPreview[]>;
  forceClean?: (selections: ForceCleanRepositorySelection[]) => Promise<ForceCleanRepositoryResult[]>;
  getRunningHookCount?: () => number;
}

export interface LogEntry {
  id: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: Date;
}

const MAX_LOG_ENTRIES = 5000;
const NOTICE_MS = 2500;

// One entry has to be one row, because that is what the log panel budgets for
// it. Sync messages carry newlines (`Synchronization finished.\n`, and with
// `debug` the whole timing table arrives as a single message), and Ink renders
// each of those as its own row however the entry is wrapped — so the panel drew
// more rows than it had, the frame outgrew the terminal and Ink repainted the
// whole screen on every render. Split rather than flatten: the table stays
// readable and every line stays addressable by the scrollback.
// A leading or trailing terminator is not a line of its own; a blank line
// between two rows of a table is, so only the empties at either end go. Both
// multi-line producers in the codebase open with one -- `Logger.table` wraps
// its content in newlines on both sides, and the sync failure line starts with
// one -- so keeping them cost a blank row and an entry off the
// `📋 Logs (N entries)` count, in the panel where rows are scarcest.
function splitLogLines(message: string): string[] {
  const lines = message.split(/\r?\n/);
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  while (lines.length > 1 && lines[0] === "") {
    lines.shift();
  }
  return lines;
}

const App: React.FC<AppProps> = ({
  events,
  repositoryCount,
  cronSchedule,
  onManualSync,
  onReload,
  onQuit,
  maxProgressLines = 2,
  getRepositoryList,
  getRepositoryDiskUsage,
  getBranchesForRepo,
  getDefaultBranchForRepo,
  fetchForRepo,
  createAndPushBranch,
  getWorktreesForRepo,
  openEditorInWorktree,
  openTerminalInWorktree,
  copyBranchFiles,
  createWorktreeForBranch,
  executeOnBranchCreatedHooks,
  getWorktreeStatusForRepo,
  getDivergedDirectoriesForRepo,
  deleteDivergedDirectory,
  getForceCleanPreview,
  forceClean,
  getRunningHookCount,
}) => {
  const [showHelp, setShowHelp] = useState(false);
  const [showBranchWizard, setShowBranchWizard] = useState(false);
  const [showOpenEditorWizard, setShowOpenEditorWizard] = useState(false);
  const [showWorktreeStatus, setShowWorktreeStatus] = useState(false);
  const [showForceClean, setShowForceClean] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing">("idle");
  // Interactive operations (branch/worktree creation) run independently of sync and
  // queue behind it. Tracked separately so they don't drive the sync `status` spinner.
  const [activeOps, setActiveOps] = useState<Array<{ id: number; label: string }>>([]);
  const opIdRef = useRef(0);
  const [syncProgressEntries, setSyncProgressEntries] = useState<AppSyncProgress[]>([]);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSyncOutcome, setLastSyncOutcome] = useState<LastSyncOutcome | null>(null);
  const [diskSpaceUsed, setDiskSpaceUsed] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [repoCount, setRepoCount] = useState(repositoryCount);
  const [schedule, setSchedule] = useState<CronScheduleDisplay>(cronSchedule);
  // A key that cannot act right now says so here, for a moment, in place of
  // the key legend -- `s` during a sync used to do nothing at all.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Non-null while `q` waits for a second press because work is still running.
  const [quitWarning, setQuitWarning] = useState<string | null>(null);
  const quitRequestedRef = useRef(false);

  const { rows } = useWindowSize();

  const addLog = useCallback((message: string, level: LogEntry["level"] = "info") => {
    setLogs((prev) => {
      // Every log line (service loggers, reload/sync failures, wizard errors)
      // lands here, so a git error that quotes a credential-bearing remote URL
      // is scrubbed before it reaches the log buffer.
      const timestamp = new Date();
      const newLogs = [
        ...prev,
        ...splitLogLines(redactSecretsInText(message)).map((line) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          message: line,
          level,
          timestamp,
        })),
      ];
      if (newLogs.length > MAX_LOG_ENTRIES) {
        return newLogs.slice(-MAX_LOG_ENTRIES);
      }
      return newLogs;
    });
  }, []);

  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const quit = (): void => {
    quitRequestedRef.current = true;
    onQuit().catch((err) => console.error("Quit failed:", err));
  };

  // What a quit right now would cut short. Quitting waits for a sync, but it
  // terminates running hooks and abandons a worktree still being created.
  const describeRunningWork = (): string | null => {
    const parts: string[] = [];
    if (status === "syncing") parts.push("a sync");
    if (activeOps.length > 0) parts.push(`${activeOps.length} operation${activeOps.length === 1 ? "" : "s"}`);
    const hooks = getRunningHookCount?.() ?? 0;
    if (hooks > 0) parts.push(`${hooks} hook${hooks === 1 ? "" : "s"}`);
    return parts.length > 0 ? parts.join(", ") : null;
  };

  useInput((input, key) => {
    // Mouse reports reach every useInput; only the scrollable panel acts on
    // them, and no shortcut here should fire off a stray click.
    if (isMouseSequence(input)) return;

    if (showHelp) {
      if (input === "?" || input === "h" || key.escape) {
        setShowHelp(false);
      }
      return;
    }

    if (showBranchWizard || showOpenEditorWizard || showWorktreeStatus || showForceClean) {
      return;
    }

    if (quitWarning !== null) {
      setQuitWarning(null);
      if (input === "q") quit();
      return;
    }

    const syncBusy = status === "syncing";

    if (input === "q") {
      // Once a quit is under way a second `q` is the service's force-quit
      // shortcut, so it goes straight through rather than asking again.
      const running = quitRequestedRef.current ? null : describeRunningWork();
      if (running) {
        setQuitWarning(`${running} still running — press q again to quit`);
      } else {
        quit();
      }
    } else if (input === "?" || input === "h") {
      setShowHelp(true);
    } else if (input === "c") {
      setShowBranchWizard(true);
    } else if (input === "o") {
      setShowOpenEditorWizard(true);
    } else if (input === "w" && getWorktreeStatusForRepo) {
      setShowWorktreeStatus(true);
    } else if ((input === "s" || input === "r" || (input === "x" && getForceCleanPreview && forceClean)) && syncBusy) {
      showNotice("A sync is in progress; try again when it finishes.");
    } else if (input === "x" && getForceCleanPreview && forceClean) {
      setShowForceClean(true);
    } else if (input === "s") {
      setStatus("syncing");
      (async () => {
        try {
          await onManualSync();
        } catch (error) {
          console.error("Manual sync failed:", error);
          setStatus("idle");
        }
      })().catch((err) => console.error("Manual sync unhandled error:", err));
    } else if (input === "r") {
      setStatus("syncing");
      (async () => {
        try {
          await onReload();
        } catch (error) {
          console.error("Reload failed:", error);
          setStatus("idle");
        }
      })().catch((err) => console.error("Reload unhandled error:", err));
    }
  });

  useEffect(() => {
    const unsubscribers = [
      // A timestamp, and nothing else. This used to end the sync as well, which
      // made it a second, ungated owner of the status bar: the service stamps
      // "Last Sync" from inside a cycle (`runSyncCycle` awaits
      // `recordSyncOutcome` before its `finally`), so the first of two
      // overlapping cycles to reach it put the bar back to `Idle`, blanked
      // the other cycle's progress rows and re-armed the `s`/`x`/`r` guards
      // while that cycle was still fetching. `setStatus` -- which the service
      // drives from a count of the cycles in flight -- is the one gate.
      events.on("updateLastSyncTime", () => {
        setLastSyncTime(new Date());
      }),
      events.on("setLastSyncOutcome", (outcome: LastSyncOutcome) => {
        setLastSyncOutcome(outcome);
      }),
      events.on("setStatus", (newStatus: "idle" | "syncing") => {
        setStatus(newStatus);
        if (newStatus === "idle") {
          setSyncProgressEntries([]);
        }
      }),
      events.on("setSyncProgress", (progress: AppSyncProgress | null) => {
        if (progress === null) {
          setSyncProgressEntries([]);
          return;
        }
        setSyncProgressEntries((prev) => {
          if (progress.completed) {
            return prev.filter((entry) => entry.repo !== progress.repo);
          }

          const existingIndex = prev.findIndex((entry) => entry.repo === progress.repo);
          if (existingIndex === -1) {
            return [...prev, progress];
          }

          return prev.map((entry, index) => (index === existingIndex ? progress : entry));
        });
      }),
      events.on("setDiskSpace", (diskSpace: string) => {
        setDiskSpaceUsed(diskSpace);
      }),
      events.on("addLog", ({ message, level }: { message: string; level: "info" | "warn" | "error" }) => {
        addLogRef.current(message, level);
      }),
      events.on("updateRepositoryCount", (count: number) => {
        setRepoCount(count);
      }),
      events.on("updateCronSchedule", (newSchedule: CronScheduleDisplay) => {
        setSchedule(newSchedule);
      }),
    ];

    events.emit("uiReady");

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progressLineCount = status === "syncing" ? Math.max(1, maxProgressLines) : 0;
  const statusBarHeight = 5 + progressLineCount + activeOps.length;
  const terminalRows = rows ?? 24;
  const logPanelHeight = Math.max(5, terminalRows - statusBarHeight);
  const showModal = showHelp || showBranchWizard || showOpenEditorWizard || showWorktreeStatus || showForceClean;

  return (
    <Box flexDirection="column" minHeight={terminalRows}>
      {!showModal && <LogPanel logs={logs} height={logPanelHeight} isActive={!showModal} />}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showBranchWizard && (
        <BranchCreationWizard
          repositories={getRepositoryList()}
          getBranchesForRepo={getBranchesForRepo}
          getDefaultBranchForRepo={getDefaultBranchForRepo}
          fetchForRepo={fetchForRepo}
          createAndPushBranch={createAndPushBranch}
          onClose={() => setShowBranchWizard(false)}
          onBranchCreated={(context) => {
            const opId = ++opIdRef.current;
            setActiveOps((prev) => [...prev, { id: opId, label: `Creating worktree ${context.newBranch}` }]);
            (async () => {
              try {
                await createWorktreeForBranch(context.repoIndex, context.newBranch);
                if (copyBranchFiles) {
                  await copyBranchFiles(context.repoIndex, context.baseBranch, context.newBranch);
                }

                if (executeOnBranchCreatedHooks) {
                  const worktrees = await getWorktreesForRepo(context.repoIndex);
                  const worktree = worktrees.find((w) => w.branch === context.newBranch);
                  if (worktree) {
                    const repos = getRepositoryList();
                    const repo = repos.find((r) => r.index === context.repoIndex);
                    executeOnBranchCreatedHooks(context.repoIndex, {
                      branchName: context.newBranch,
                      worktreePath: worktree.path,
                      repoName: repo?.name || `repo-${context.repoIndex}`,
                      baseBranch: context.baseBranch,
                      repoUrl: repo?.repoUrl || "",
                    });
                  }
                }
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                events.emit("addLog", {
                  message: `Failed to create worktree: ${errorMsg}`,
                  level: "error",
                });
              } finally {
                setActiveOps((prev) => prev.filter((op) => op.id !== opId));
              }
            })().catch((err) => console.error("Branch creation unhandled error:", err));
          }}
          onComplete={() => {
            setShowBranchWizard(false);
          }}
        />
      )}

      {showOpenEditorWizard && (
        <OpenEditorWizard
          repositories={getRepositoryList()}
          getWorktreesForRepo={getWorktreesForRepo}
          openEditorInWorktree={openEditorInWorktree}
          openTerminalInWorktree={openTerminalInWorktree}
          onClose={() => setShowOpenEditorWizard(false)}
        />
      )}

      {showWorktreeStatus && getWorktreeStatusForRepo && (
        <WorktreeStatusView
          repositories={getRepositoryList()}
          getWorktreeStatusForRepo={getWorktreeStatusForRepo}
          getRepositoryDiskUsage={getRepositoryDiskUsage}
          getDivergedDirectoriesForRepo={getDivergedDirectoriesForRepo}
          deleteDivergedDirectory={deleteDivergedDirectory}
          onClose={() => setShowWorktreeStatus(false)}
        />
      )}

      {showForceClean && getForceCleanPreview && forceClean && (
        <ForceCleanModal
          getPreview={getForceCleanPreview}
          forceClean={forceClean}
          onClose={() => setShowForceClean(false)}
        />
      )}

      <StatusBar
        status={status}
        syncProgressEntries={syncProgressEntries}
        activeOps={activeOps.map((op) => op.label)}
        maxProgressLines={maxProgressLines}
        repositoryCount={repoCount}
        lastSyncTime={lastSyncTime}
        lastSyncOutcome={lastSyncOutcome}
        cronSchedule={schedule}
        diskSpaceUsed={diskSpaceUsed ?? undefined}
        notice={quitWarning ?? notice}
      />
    </Box>
  );
};

export default App;
