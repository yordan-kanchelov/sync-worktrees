import React, { useState, useEffect, useCallback } from "react";
import { Box, useInput, useStdout } from "ink";
import StatusBar from "./StatusBar";
import HelpModal from "./HelpModal";
import BranchCreationWizard from "./BranchCreationWizard";
import OpenEditorWizard from "./OpenEditorWizard";
import LogPanel from "./LogPanel";
import { appEvents } from "../utils/app-events";

export interface AppProps {
  repositoryCount: number;
  cronSchedule?: string;
  onManualSync: () => void;
  onReload: () => void;
  onQuit: () => Promise<void>;
  getRepositoryList: () => Array<{ index: number; name: string; repoUrl: string }>;
  getBranchesForRepo: (index: number) => Promise<string[]>;
  getDefaultBranchForRepo: (index: number) => string;
  createAndPushBranch: (
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ) => Promise<{ success: boolean; finalName: string; error?: string }>;
  getWorktreesForRepo: (index: number) => Promise<Array<{ path: string; branch: string }>>;
  openEditorInWorktree: (worktreePath: string) => { success: boolean; error?: string };
  copyBranchFiles?: (repoIndex: number, baseBranch: string, targetBranch: string) => Promise<void>;
  createWorktreeForBranch: (repoIndex: number, branchName: string) => Promise<void>;
}

export interface LogEntry {
  id: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: Date;
}

const MAX_LOG_ENTRIES = 1000;

const App: React.FC<AppProps> = ({
  repositoryCount,
  cronSchedule,
  onManualSync,
  onReload,
  onQuit,
  getRepositoryList,
  getBranchesForRepo,
  getDefaultBranchForRepo,
  createAndPushBranch,
  getWorktreesForRepo,
  openEditorInWorktree,
  copyBranchFiles,
  createWorktreeForBranch,
}) => {
  const [showHelp, setShowHelp] = useState(false);
  const [showBranchWizard, setShowBranchWizard] = useState(false);
  const [showOpenEditorWizard, setShowOpenEditorWizard] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing">("idle");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [diskSpaceUsed, setDiskSpaceUsed] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

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

  useInput((input) => {
    if (showHelp) {
      if (input === "?" || input === "h") {
        setShowHelp(false);
      }
      return;
    }

    if (showBranchWizard || showOpenEditorWizard) {
      return;
    }

    if (input === "q") {
      void onQuit();
    } else if (input === "?" || input === "h") {
      setShowHelp(true);
    } else if (input === "c" && status === "idle") {
      setShowBranchWizard(true);
    } else if (input === "o" && status === "idle") {
      setShowOpenEditorWizard(true);
    } else if (input === "s" && status !== "syncing") {
      setStatus("syncing");
      void (async () => {
        try {
          await onManualSync();
        } catch (error) {
          console.error("Manual sync failed:", error);
          setStatus("idle");
        }
      })();
    } else if (input === "r" && status !== "syncing") {
      setStatus("syncing");
      void (async () => {
        try {
          await onReload();
        } catch (error) {
          console.error("Reload failed:", error);
          setStatus("idle");
        }
      })();
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
        addLog(message, level);
      }),
    ];

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [addLog]);

  const statusBarHeight = 5;
  const terminalRows = stdout.rows ?? 24;
  const logPanelHeight = Math.max(5, terminalRows - statusBarHeight);
  const showModal = showHelp || showBranchWizard || showOpenEditorWizard;

  return (
    <Box flexDirection="column" minHeight={terminalRows}>
      {!showModal && <LogPanel logs={logs} height={logPanelHeight} isActive={!showModal} />}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showBranchWizard && (
        <BranchCreationWizard
          repositories={getRepositoryList()}
          getBranchesForRepo={getBranchesForRepo}
          getDefaultBranchForRepo={getDefaultBranchForRepo}
          createAndPushBranch={createAndPushBranch}
          onClose={() => setShowBranchWizard(false)}
          onComplete={(success, context) => {
            setShowBranchWizard(false);
            if (success && context) {
              setStatus("syncing");
              void (async () => {
                try {
                  await createWorktreeForBranch(context.repoIndex, context.newBranch);
                  if (copyBranchFiles) {
                    await copyBranchFiles(context.repoIndex, context.baseBranch, context.newBranch);
                  }
                } catch (error) {
                  console.error("Failed to create worktree:", error);
                } finally {
                  setStatus("idle");
                }
              })();
            }
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

      <StatusBar
        status={status}
        repositoryCount={repositoryCount}
        lastSyncTime={lastSyncTime}
        cronSchedule={cronSchedule}
        diskSpaceUsed={diskSpaceUsed ?? undefined}
      />
    </Box>
  );
};

export default App;
