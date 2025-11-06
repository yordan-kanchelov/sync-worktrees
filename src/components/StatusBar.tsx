import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { CronExpressionParser } from "cron-parser";

export interface StatusBarProps {
  status: "idle" | "syncing";
  repositoryCount: number;
  lastSyncTime: Date | null;
  cronSchedule?: string;
  diskSpaceUsed?: string;
}

const StatusBar: React.FC<StatusBarProps> = ({ status, repositoryCount, lastSyncTime, cronSchedule, diskSpaceUsed }) => {
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
        const nextInterval = CronExpressionParser.parse(cronSchedule);
        setNextSyncTime(nextInterval.next().toDate());
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
        <Box justifyContent="space-between">
          <Text>
            Disk Space: <Text color="magenta">{diskSpaceUsed || "Calculating..."}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default StatusBar;
