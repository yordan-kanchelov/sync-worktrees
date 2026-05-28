import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { CronExpressionParser } from "cron-parser";

import type { AppSyncProgress } from "../utils/app-events";

export interface StatusBarProps {
  status: "idle" | "syncing";
  syncProgressEntries?: AppSyncProgress[];
  maxProgressLines?: number;
  repositoryCount: number;
  lastSyncTime: Date | null;
  cronSchedule?: string;
  diskSpaceUsed?: string;
}

const StatusBar: React.FC<StatusBarProps> = ({
  status,
  syncProgressEntries = [],
  maxProgressLines = 2,
  repositoryCount,
  lastSyncTime,
  cronSchedule,
  diskSpaceUsed,
}) => {
  const [nextSyncTime, setNextSyncTime] = useState<Date | null>(null);

  useEffect(() => {
    if (!cronSchedule) {
      setNextSyncTime(null);
      return undefined;
    }

    try {
      const interval = CronExpressionParser.parse(cronSchedule);
      setNextSyncTime(interval.next().toDate());

      const timer = setInterval(() => {
        const fresh = CronExpressionParser.parse(cronSchedule);
        setNextSyncTime(fresh.next().toDate());
      }, 60000);

      return () => clearInterval(timer);
    } catch (error) {
      setNextSyncTime(null);
      return undefined;
    }
  }, [cronSchedule]);

  const formatTime = (date: Date | null): string => {
    if (!date) return "N/A";
    return date.toLocaleTimeString();
  };

  const getStatusColor = (): "green" | "yellow" => {
    return status === "syncing" ? "yellow" : "green";
  };

  const getStatusIcon = (): string => {
    return status === "syncing" ? "⟳" : "✓";
  };

  const formatProgress = (syncProgress: AppSyncProgress): string => {
    const percent =
      syncProgress.progress === undefined || syncProgress.message.includes(`${syncProgress.progress}%`)
        ? ""
        : ` ${syncProgress.progress}%`;
    return `[${syncProgress.repo}] ${syncProgress.message}${percent}`;
  };

  const progressLineCount = Math.max(1, maxProgressLines);
  const visibleProgress = syncProgressEntries.slice(-progressLineCount);

  return (
    <Box borderStyle="single" paddingX={1}>
      <Box flexDirection="column" width="100%">
        <Box justifyContent="space-between">
          <Text bold>
            {getStatusIcon()} Status:{" "}
            <Text color={getStatusColor()}>{status === "syncing" ? "Syncing..." : "Running"}</Text>
          </Text>
          <Text>
            Repositories: <Text bold color="cyan">{repositoryCount}</Text>
          </Text>
        </Box>
        <Box justifyContent="space-between">
          <Text>
            Last Sync: <Text color="gray">{formatTime(lastSyncTime)}</Text>
          </Text>
          {cronSchedule && (
            <Text>
              Next Sync: <Text color="gray">{formatTime(nextSyncTime)}</Text>
            </Text>
          )}
        </Box>
        {status === "syncing" &&
          Array.from({ length: progressLineCount }).map((_, index) => {
            const entry = visibleProgress[index];
            const message = entry ? formatProgress(entry) : index === 0 ? "waiting for progress events" : "";
            return (
              <Box key={index}>
                <Text wrap="truncate">
                  {message ? "Progress: " : " "}
                  {message && <Text color="cyan">{message}</Text>}
                </Text>
              </Box>
            );
          })}
        <Box justifyContent="space-between">
          <Text>
            Disk Space: <Text color="magenta">{diskSpaceUsed || "Calculating..."}</Text>
          </Text>
          <Text dimColor>
            <Text color="yellow">s</Text>ync{" "}
            <Text color="yellow">c</Text>reate{" "}
            <Text color="yellow">o</Text>pen{" "}
            <Text color="yellow">w</Text>tree{" "}
            <Text color="yellow">r</Text>eload{" "}
            <Text color="yellow">?</Text>help{" "}
            <Text color="yellow">q</Text>uit
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default StatusBar;
