import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { LogEntry } from "./App";

export interface LogPanelProps {
  logs: LogEntry[];
  height: number;
  isActive: boolean;
}

const LogPanel: React.FC<LogPanelProps> = ({ logs, height, isActive }) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  const borderLines = 2;
  const headerLine = 1;
  const visibleLines = Math.max(1, height - borderLines - headerLine);
  const maxOffset = Math.max(0, logs.length - visibleLines);

  useEffect(() => {
    if (autoScroll && scrollOffset !== maxOffset) {
      setScrollOffset(maxOffset);
    }
  }, [logs.length, maxOffset, autoScroll, scrollOffset]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.upArrow) {
        setScrollOffset((prev) => Math.max(0, prev - 1));
        setAutoScroll(false);
      } else if (key.downArrow) {
        const newOffset = Math.min(maxOffset, scrollOffset + 1);
        setScrollOffset(newOffset);
        if (newOffset >= maxOffset) {
          setAutoScroll(true);
        }
      } else if (key.pageUp) {
        setScrollOffset((prev) => Math.max(0, prev - visibleLines));
        setAutoScroll(false);
      } else if (key.pageDown) {
        const newOffset = Math.min(maxOffset, scrollOffset + visibleLines);
        setScrollOffset(newOffset);
        if (newOffset >= maxOffset) {
          setAutoScroll(true);
        }
      }
    },
    { isActive },
  );

  const getLogColor = (level: LogEntry["level"]): "red" | "yellow" | undefined => {
    switch (level) {
      case "error":
        return "red";
      case "warn":
        return "yellow";
      default:
        return undefined;
    }
  };

  const visibleLogs = logs.slice(scrollOffset, scrollOffset + visibleLines);
  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + visibleLines < logs.length;
  const aboveCount = scrollOffset;
  const belowCount = logs.length - scrollOffset - visibleLines;

  const emptyLines = Math.max(0, visibleLines - visibleLogs.length);

  return (
    <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          📋 Logs {logs.length > 0 && <Text dimColor>({logs.length} entries)</Text>}
        </Text>
        {isActive && (
          <Text dimColor>
            {hasMoreAbove || hasMoreBelow ? "↑/↓ scroll" : ""} {autoScroll ? "(auto)" : ""}
          </Text>
        )}
      </Box>

      {hasMoreAbove && (
        <Text dimColor>
          ↑ {aboveCount} more above
        </Text>
      )}

      {visibleLogs.map((log) => (
        <Text key={log.id} color={getLogColor(log.level)} wrap="truncate">
          {log.message}
        </Text>
      ))}

      {Array.from({ length: emptyLines }).map((_, i) => (
        <Text key={`empty-${i}`}> </Text>
      ))}

      {hasMoreBelow && (
        <Text dimColor>
          ↓ {belowCount} more below
        </Text>
      )}
    </Box>
  );
};

export default LogPanel;
