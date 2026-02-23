import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, useInput, useStdout } from "ink";
import StatusBar from "./StatusBar";
import HelpModal from "./HelpModal";
import BranchCreationWizard from "./BranchCreationWizard";
import OpenEditorWizard from "./OpenEditorWizard";
import WorktreeStatusView from "./WorktreeStatusView";
import LogPanel from "./LogPanel";
import { appEvents } from "../utils/app-events";

import type { HookContext, WorktreeStatusEntry } from "../types";

export type { HookContext, WorktreeStatusEntry };

export interface AppProps {
  repositoryCount: number;
  cronSchedule?: string;
  onManualSync: () => void;
  onReload: () => void;
  onQuit: () => Promise<void>;
  getRepositoryList: () => Array<{ index: number; name: string; repoUrl: string }>;
  getBranchesForRepo: (index: number) => Promise<string[]>;
  getDefaultBranchForRepo: (index: number) => string;
  fetchForRepo?: (index: number) => Promise<void>;
  createAndPushBranch: (
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ) => Promise<{ success: boolean; finalName: string; error?: string }>;
  getWorktreesForRepo: (index: number) => Promise<Array<{ path: string; branch: string }>>;
  openEditorInWorktree: (worktreePath: string) => { success: boolean; error?: string };
  copyBranchFiles?: (repoIndex: number, baseBranch: string, targetBranch: string) => Promise<void>;
  createWorktreeForBranch: (repoIndex: number, branchName: string) => Promise<void>;
  executeOnBranchCreatedHooks?: (repoIndex: number, context: HookContext) => void;
  getWorktreeStatusForRepo?: (index: number) => Promise<WorktreeStatusEntry[]>;
}

export interface LogEntry {
  id: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: Date;
}

const MAX_LOG_ENTRIES = 5000;

const App: React.FC<AppProps> = ({
  repositoryCount,
  cronSchedule,
  onManualSync,
  onReload,
  onQuit,
  getRepositoryList,
  getBranchesForRepo,
  getDefaultBranchForRepo,
  fetchForRepo,
  createAndPushBranch,
  getWorktreesForRepo,
  openEditorInWorktree,
  copyBranchFiles,
  createWorktreeForBranch,
  executeOnBranchCreatedHooks,
  getWorktreeStatusForRepo,
}) => {
  const [showHelp, setShowHelp] = useState(false);
  const [showBranchWizard, setShowBranchWizard] = useState(false);
  const [showOpenEditorWizard, setShowOpenEditorWizard] = useState(false);
  const [showWorktreeStatus, setShowWorktreeStatus] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing">("idle");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [diskSpaceUsed, setDiskSpaceUsed] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [repoCount, setRepoCount] = useState(repositoryCount);
  const [schedule, setSchedule] = useState(cronSchedule);

  const { stdout } = useStdout();

  const addLog = useCallback((message: string, level: LogEntry["level"] = "info") => {
    setLogs((prev) => {
      const newLogs = [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          message,
          level,
          timestamp: new Date(),
        },
      ];
      if (newLogs.length > MAX_LOG_ENTRIES) {
        return newLogs.slice(-MAX_LOG_ENTRIES);
      }
      return newLogs;
    });
  }, []);

  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;

  useInput((input, key) => {
    if (showHelp) {
      if (input === "?" || input === "h" || key.escape) {
        setShowHelp(false);
      }
      return;
    }

    if (showBranchWizard || showOpenEditorWizard || showWorktreeStatus) {
      return;
    }

    if (input === "q") {
      onQuit().catch((err) => console.error("Quit failed:", err));
    } else if (input === "?" || input === "h") {
      setShowHelp(true);
    } else if (input === "c" && status === "idle") {
      setShowBranchWizard(true);
    } else if (input === "o" && status === "idle") {
      setShowOpenEditorWizard(true);
    } else if (input === "w" && status === "idle" && getWorktreeStatusForRepo) {
      setShowWorktreeStatus(true);
    } else if (input === "s" && status !== "syncing") {
      setStatus("syncing");
      (async () => {
        try {
          await onManualSync();
        } catch (error) {
          console.error("Manual sync failed:", error);
          setStatus("idle");
        }
      })().catch((err) => console.error("Manual sync unhandled error:", err));
    } else if (input === "r" && status !== "syncing") {
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

  const updateLastSyncTime = useCallback(() => {
    setLastSyncTime(new Date());
    setStatus("idle");
  }, []);

  useEffect(() => {
    const unsubscribers = [
      appEvents.on("updateLastSyncTime", () => {
        setLastSyncTime(new Date());
        setStatus("idle");
      }),
      appEvents.on("setStatus", (newStatus: "idle" | "syncing") => {
        setStatus(newStatus);
      }),
      appEvents.on("setDiskSpace", (diskSpace: string) => {
        setDiskSpaceUsed(diskSpace);
      }),
      appEvents.on("addLog", ({ message, level }: { message: string; level: "info" | "warn" | "error" }) => {
        addLogRef.current(message, level);
      }),
      appEvents.on("updateRepositoryCount", (count: number) => {
        setRepoCount(count);
      }),
      appEvents.on("updateCronSchedule", (newSchedule: string | undefined) => {
        setSchedule(newSchedule);
      }),
    ];

    appEvents.emit("uiReady");

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusBarHeight = 5;
  const terminalRows = stdout.rows ?? 24;
  const logPanelHeight = Math.max(5, terminalRows - statusBarHeight);
  const showModal = showHelp || showBranchWizard || showOpenEditorWizard || showWorktreeStatus;

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
            setStatus("syncing");
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
                appEvents.emit("addLog", {
                  message: `Failed to create worktree: ${errorMsg}`,
                  level: "error",
                });
              } finally {
                setStatus("idle");
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
          onClose={() => setShowOpenEditorWizard(false)}
        />
      )}

      {showWorktreeStatus && getWorktreeStatusForRepo && (
        <WorktreeStatusView
          repositories={getRepositoryList()}
          getWorktreeStatusForRepo={getWorktreeStatusForRepo}
          onClose={() => setShowWorktreeStatus(false)}
        />
      )}

      <StatusBar
        status={status}
        repositoryCount={repoCount}
        lastSyncTime={lastSyncTime}
        cronSchedule={schedule}
        diskSpaceUsed={diskSpaceUsed ?? undefined}
      />
    </Box>
  );
};

export default App;
