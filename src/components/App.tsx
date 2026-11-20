import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Box, useInput, useWindowSize } from "ink";
import StatusBar from "./StatusBar";
import HelpModal from "./HelpModal";
import BranchCreationWizard from "./BranchCreationWizard";
import OpenEditorWizard from "./OpenEditorWizard";
import WorktreeStatusView from "./WorktreeStatusView";
import ForceCleanModal from "./ForceCleanModal";
import FuzzySwitcher from "./FuzzySwitcher";
import LogPanel, { CollapsedLogLine, useLogScroll } from "./LogPanel";
import RepositoryDashboard from "./RepositoryDashboard";
import { LOG_MIN_ROWS, LOG_RESIZE_STEP, homeLayout } from "./layout";
import type { LogSizePreference } from "./layout";
import { redactSecretsInText } from "../utils/git-url";
import { isMouseSequence } from "../utils/mouse";
import type { AppEventEmitter } from "../utils/app-events";
import type {
  AppSyncProgress,
  CronScheduleDisplay,
  LastSyncOutcome,
  RepositoryDashboardRow,
} from "../utils/app-events";
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
  onSyncRepository?: (index: number) => void | Promise<void>;
  copyToClipboard?: (text: string) => Promise<{ success: boolean; error?: string }>;
}

export interface LogEntry {
  id: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: Date;
}

const MAX_LOG_ENTRIES = 5000;
const NOTICE_MS = 2500;

export const LOG_FLUSH_INTERVAL_MS = 50;

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
  onSyncRepository,
  copyToClipboard,
}) => {
  const [showHelp, setShowHelp] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [statusTarget, setStatusTarget] = useState<{ repoIndex: number; branch: string } | null>(null);
  const [showBranchWizard, setShowBranchWizard] = useState(false);
  const [showOpenEditorWizard, setShowOpenEditorWizard] = useState(false);
  const [showWorktreeStatus, setShowWorktreeStatus] = useState(false);
  const [showForceClean, setShowForceClean] = useState(false);
  const [status, setStatusState] = useState<"idle" | "syncing">("idle");
  const [activeOps, setActiveOps] = useState<Array<{ id: number; label: string }>>([]);
  const opIdRef = useRef(0);
  const [syncProgressEntries, setSyncProgressEntries] = useState<AppSyncProgress[]>([]);
  const statusRef = useRef<"idle" | "syncing">("idle");
  const setStatus = (next: "idle" | "syncing"): void => {
    if (next !== statusRef.current || next === "idle") setSyncProgressEntries([]);
    statusRef.current = next;
    setStatusState(next);
  };
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSyncOutcome, setLastSyncOutcome] = useState<LastSyncOutcome | null>(null);
  const [diskSpaceUsed, setDiskSpaceUsed] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [repoCount, setRepoCount] = useState(repositoryCount);
  const [progressLineLimit, setProgressLineLimit] = useState(maxProgressLines);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const reloadGenerationRef = useRef(0);
  const [schedule, setSchedule] = useState<CronScheduleDisplay>(cronSchedule);
  const [dashboardRows, setDashboardRows] = useState<readonly RepositoryDashboardRow[]>([]);
  const [logSize, setLogSize] = useState<LogSizePreference>({ collapsed: false, rows: null });
  const logScroll = useLogScroll();
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quitWarning, setQuitWarning] = useState<string | null>(null);
  const quitRequestedRef = useRef(false);

  const { rows } = useWindowSize();

  const terminalRows = rows ?? 24;
  const progressLineCap = Math.max(
    1,
    Math.min(progressLineLimit, repoCount, terminalRows - 5 - activeOps.length - LOG_MIN_ROWS),
  );
  const progressLineCount = status === "syncing" ? progressLineCap : 0;
  const statusBarHeight = 5 + progressLineCount + activeOps.length;
  const showModal =
    showHelp || showBranchWizard || showOpenEditorWizard || showWorktreeStatus || showForceClean || showSwitcher;
  const availableRows = Math.max(0, terminalRows - statusBarHeight);
  const modalRows = availableRows;
  const home = homeLayout(availableRows, dashboardRows.length, logSize);
  const lFoldsOnly =
    logSize.collapsed &&
    !homeLayout(availableRows, dashboardRows.length, { ...logSize, collapsed: false }).logCollapsed;

  const pendingLogsRef = useRef<LogEntry[]>([]);
  const logFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logIdRef = useRef(0);

  const flushLogs = useCallback(() => {
    logFlushTimerRef.current = null;
    const pending = pendingLogsRef.current;
    if (pending.length === 0) return;
    pendingLogsRef.current = [];
    setLogs((prev) => {
      const next = prev.concat(pending);
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
    });
  }, []);

  const addLog = useCallback(
    (message: string, level: LogEntry["level"] = "info") => {
      const timestamp = new Date();
      for (const line of splitLogLines(redactSecretsInText(message))) {
        pendingLogsRef.current.push({ id: `log-${++logIdRef.current}`, message: line, level, timestamp });
      }
      logFlushTimerRef.current ??= setTimeout(flushLogs, LOG_FLUSH_INTERVAL_MS);
    },
    [flushLogs],
  );

  useEffect(
    () => () => {
      if (logFlushTimerRef.current) {
        clearTimeout(logFlushTimerRef.current);
        logFlushTimerRef.current = null;
      }
    },
    [],
  );

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

  const describeRunningWork = (): string | null => {
    const parts: string[] = [];
    if (status === "syncing") parts.push("a sync");
    if (activeOps.length > 0) parts.push(`${activeOps.length} operation${activeOps.length === 1 ? "" : "s"}`);
    const hooks = getRunningHookCount?.() ?? 0;
    if (hooks > 0) parts.push(`${hooks} hook${hooks === 1 ? "" : "s"}`);
    return parts.length > 0 ? parts.join(", ") : null;
  };

  useInput((input, key) => {
    if (isMouseSequence(input)) return;

    if (showHelp || showBranchWizard || showOpenEditorWizard || showWorktreeStatus || showForceClean || showSwitcher) {
      return;
    }

    if (quitWarning !== null) {
      setQuitWarning(null);
      if (input === "q") quit();
      return;
    }

    const syncBusy = status === "syncing";

    if (input === "q") {
      const running = quitRequestedRef.current ? null : describeRunningWork();
      if (running) {
        setQuitWarning(`${running} still running — press q again to quit`);
      } else {
        quit();
      }
    } else if (input === "?" || input === "h") {
      setShowHelp(true);
    } else if (input === "l") {
      setLogSize((prev) => ({ ...prev, collapsed: !prev.collapsed }));
    } else if (input === "+" || input === "=") {
      setLogSize(
        lFoldsOnly
          ? { ...logSize, collapsed: false }
          : {
              collapsed: false,
              rows: Math.min(availableRows, home.logCollapsed ? LOG_MIN_ROWS : home.logRows + LOG_RESIZE_STEP),
            },
      );
    } else if (input === "-" || input === "_") {
      if (!home.logCollapsed) {
        const rows = home.logRows - LOG_RESIZE_STEP;
        const next = { collapsed: false, rows };
        const shrinks =
          rows >= LOG_MIN_ROWS && homeLayout(availableRows, dashboardRows.length, next).logRows < home.logRows;
        setLogSize(shrinks ? next : { collapsed: true, rows: Math.max(LOG_MIN_ROWS, rows) });
      }
    } else if (input === "/" || (key.ctrl && input === "p")) {
      setShowSwitcher(true);
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
      events.on("updateLastSyncTime", () => {
        setLastSyncTime(new Date());
      }),
      events.on("setLastSyncOutcome", (outcome: LastSyncOutcome) => {
        setLastSyncOutcome(outcome);
      }),
      events.on("setStatus", (newStatus: "idle" | "syncing") => {
        setStatus(newStatus);
      }),
      events.on("setSyncProgress", (progress: AppSyncProgress | null) => {
        if (progress === null) {
          setSyncProgressEntries([]);
          return;
        }
        if (statusRef.current !== "syncing") return;
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
        addLog(message, level);
      }),
      events.on("updateRepositoryCount", (count: number) => {
        setRepoCount(count);
      }),
      events.on("updateMaxProgressLines", (lines: number) => {
        setProgressLineLimit(lines);
      }),
      events.on("repositoriesReloaded", (generation: number) => {
        reloadGenerationRef.current = generation;
        setReloadGeneration(generation);
        setShowBranchWizard(false);
        setShowOpenEditorWizard(false);
        setShowWorktreeStatus(false);
        setShowSwitcher(false);
        setStatusTarget(null);
      }),
      events.on("updateCronSchedule", (newSchedule: CronScheduleDisplay) => {
        setSchedule(newSchedule);
      }),
      events.on("setRepositoryDashboard", (rows: readonly RepositoryDashboardRow[]) => {
        setDashboardRows(rows);
      }),
    ];

    events.emit("uiReady");

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncRepository = onSyncRepository
    ? (repoIndex: number): string | null => {
        if (status === "syncing") return "A sync is in progress; try again when it finishes.";
        setStatus("syncing");
        (async () => {
          try {
            await onSyncRepository(repoIndex);
          } catch (error) {
            addLog(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            setStatus("idle");
          }
        })().catch((err) => console.error("Repository sync unhandled error:", err));
        return null;
      }
    : undefined;

  const showRepositoryPicker = showBranchWizard || showOpenEditorWizard || showWorktreeStatus || showSwitcher;
  const repositories = useMemo(
    () => (showRepositoryPicker ? getRepositoryList() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showRepositoryPicker, getRepositoryList, reloadGeneration],
  );
  const activeOpLabels = useMemo(() => activeOps.map((op) => op.label), [activeOps]);

  return (
    <Box flexDirection="column" minHeight={terminalRows}>
      {!showModal && home.dashboardRows > 0 && <RepositoryDashboard rows={dashboardRows} height={home.dashboardRows} />}
      {!showModal && !home.logCollapsed && <LogPanel logs={logs} height={home.logRows} scroll={logScroll} />}
      {!showModal && home.logCollapsed && (
        <>
          <Box flexGrow={1} />
          <CollapsedLogLine logs={logs} expandKey={lFoldsOnly ? "l" : "+"} />
        </>
      )}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} availableRows={modalRows} />}

      {showBranchWizard && (
        <BranchCreationWizard
          repositories={repositories}
          availableRows={modalRows}
          getBranchesForRepo={getBranchesForRepo}
          getDefaultBranchForRepo={getDefaultBranchForRepo}
          fetchForRepo={fetchForRepo}
          createAndPushBranch={createAndPushBranch}
          onClose={() => setShowBranchWizard(false)}
          onBranchCreated={(context) => {
            const generation = reloadGeneration;
            const reloaded = (skipped: string): boolean => {
              if (reloadGenerationRef.current === generation) return false;
              events.emit("addLog", {
                message: `The configuration was reloaded; skipped ${skipped} for '${context.newBranch}'.`,
                level: "error",
              });
              return true;
            };
            const opId = ++opIdRef.current;
            setActiveOps((prev) => [...prev, { id: opId, label: `Creating worktree ${context.newBranch}` }]);
            (async () => {
              try {
                if (reloaded("the worktree, file copy and hooks")) return;
                await createWorktreeForBranch(context.repoIndex, context.newBranch);
                if (copyBranchFiles) {
                  if (reloaded("file copy and hooks")) return;
                  await copyBranchFiles(context.repoIndex, context.baseBranch, context.newBranch);
                }

                if (executeOnBranchCreatedHooks) {
                  if (reloaded("hooks")) return;
                  const worktrees = await getWorktreesForRepo(context.repoIndex);
                  const worktree = worktrees.find((w) => w.branch === context.newBranch);
                  if (worktree && !reloaded("hooks")) {
                    const repos = getRepositoryList();
                    const repo = repos.find((r) => r.index === context.repoIndex);
                    executeOnBranchCreatedHooks(context.repoIndex, {
                      branchName: context.newBranch,
                      worktreePath: worktree.path,
                      repoName: repo?.name ?? "",
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
          repositories={repositories}
          availableRows={modalRows}
          getWorktreesForRepo={getWorktreesForRepo}
          openEditorInWorktree={openEditorInWorktree}
          openTerminalInWorktree={openTerminalInWorktree}
          onClose={() => setShowOpenEditorWizard(false)}
        />
      )}

      {showWorktreeStatus && getWorktreeStatusForRepo && (
        <WorktreeStatusView
          repositories={repositories}
          availableRows={modalRows}
          getWorktreeStatusForRepo={getWorktreeStatusForRepo}
          getRepositoryDiskUsage={getRepositoryDiskUsage}
          getDivergedDirectoriesForRepo={getDivergedDirectoriesForRepo}
          deleteDivergedDirectory={deleteDivergedDirectory}
          initialRepoIndex={statusTarget?.repoIndex}
          initialBranch={statusTarget?.branch}
          onClose={() => {
            setShowWorktreeStatus(false);
            setStatusTarget(null);
          }}
        />
      )}

      {showSwitcher && (
        <FuzzySwitcher
          repositories={repositories}
          availableRows={modalRows}
          getWorktreesForRepo={getWorktreesForRepo}
          openEditorInWorktree={openEditorInWorktree}
          openTerminalInWorktree={openTerminalInWorktree}
          copyToClipboard={copyToClipboard}
          syncRepository={syncRepository}
          showStatus={
            getWorktreeStatusForRepo
              ? (repoIndex, branch) => {
                  setStatusTarget({ repoIndex, branch });
                  setShowSwitcher(false);
                  setShowWorktreeStatus(true);
                }
              : undefined
          }
          notify={showNotice}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      {showForceClean && getForceCleanPreview && forceClean && (
        <ForceCleanModal
          availableRows={modalRows}
          getPreview={getForceCleanPreview}
          forceClean={forceClean}
          onClose={() => setShowForceClean(false)}
        />
      )}

      <StatusBar
        status={status}
        syncProgressEntries={syncProgressEntries}
        activeOps={activeOpLabels}
        maxProgressLines={progressLineCap}
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
