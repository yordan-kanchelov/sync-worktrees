import React, { useState, useEffect, useCallback } from "react";
import { Box, useInput } from "ink";
import StatusBar from "./StatusBar";
import HelpModal from "./HelpModal";

export interface AppProps {
  repositoryCount: number;
  cronSchedule?: string;
  onManualSync: () => void;
  onReload: () => void;
  onQuit: () => Promise<void>;
}

export interface LogEntry {
  id: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: Date;
}

const App: React.FC<AppProps> = ({ repositoryCount, cronSchedule, onManualSync, onReload, onQuit }) => {
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing">("idle");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      void onQuit();
    } else if (input === "?" || input === "h") {
      setShowHelp(prev => !prev);
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
    (globalThis as any).__inkAppMethods = {
      updateLastSyncTime,
      setStatus,
    };

    return () => {
      delete (globalThis as any).__inkAppMethods;
    };
  }, [updateLastSyncTime, setStatus]);

  return (
    <Box flexDirection="column">
      <StatusBar
        status={status}
        repositoryCount={repositoryCount}
        lastSyncTime={lastSyncTime}
        cronSchedule={cronSchedule}
      />

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </Box>
  );
};

export default App;
