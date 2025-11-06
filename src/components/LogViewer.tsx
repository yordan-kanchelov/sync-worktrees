import React from "react";
import { Box, Text } from "ink";
import { LogEntry } from "./App";

export interface LogViewerProps {
  logs: LogEntry[];
  maxLines?: number;
}

const LogViewer: React.FC<LogViewerProps> = ({ logs, maxLines = 100 }) => {
  const visibleLogs = logs.slice(-maxLines);

  const getLogColor = (level: "info" | "warn" | "error"): "white" | "yellow" | "red" => {
    switch (level) {
      case "warn":
        return "yellow";
      case "error":
        return "red";
      default:
        return "white";
    }
  };

  const formatTimestamp = (timestamp: Date): string => {
    return timestamp.toLocaleTimeString();
  };

  if (visibleLogs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No logs yet. Waiting for sync operations...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {visibleLogs.map((log) => (
        <Box key={log.id}>
          <Text dimColor>[{formatTimestamp(log.timestamp)}]</Text>
          <Text> </Text>
          <Text color={getLogColor(log.level)}>{log.message}</Text>
        </Box>
      ))}
    </Box>
  );
};

export default LogViewer;
