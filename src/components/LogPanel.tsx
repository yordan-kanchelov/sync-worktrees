import React, { useState, useEffect, useRef, useReducer } from "react";
import type { Dispatch } from "react";
import { Box, Text, useInput } from "ink";
import { parseWheelEvent } from "../utils/mouse";
import type { LogEntry } from "./App";

const WHEEL_LINES = 3;

export type ScrollState = { follow: boolean; offset: number };

export type ScrollAction =
  { type: "by"; delta: number; maxOffset: number } | { type: "top" } | { type: "bottom"; maxOffset: number };

function scrollReducer(state: ScrollState, action: ScrollAction): ScrollState {
  switch (action.type) {
    case "top":
      return { follow: false, offset: 0 };
    case "bottom":
      return { follow: true, offset: action.maxOffset };
    case "by": {
      const from = state.follow ? action.maxOffset : Math.min(state.offset, action.maxOffset);
      const next = Math.min(action.maxOffset, Math.max(0, from + action.delta));
      return { follow: next >= action.maxOffset, offset: next };
    }
  }
}

export type LogScroll = [ScrollState, Dispatch<ScrollAction>];

export function useLogScroll(): LogScroll {
  return useReducer(scrollReducer, { follow: true, offset: 0 });
}

export interface LogPanelProps {
  logs: LogEntry[];
  height: number;
  scroll: LogScroll;
}

const LogPanel: React.FC<LogPanelProps> = ({ logs, height, scroll: [scroll, dispatch] }) => {
  const [pendingG, setPendingG] = useState(false);
  const gTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const borderLines = 2;
  const headerLine = 1;
  const contentLines = Math.max(1, height - borderLines - headerLine);
  const indicatorLines = logs.length > contentLines ? Math.min(2, Math.max(0, contentLines - 1)) : 0;
  const visibleLines = Math.max(1, contentLines - indicatorLines);
  const maxOffset = Math.max(0, logs.length - visibleLines);

  const scrollOffset = scroll.follow ? maxOffset : Math.min(scroll.offset, maxOffset);
  const autoScroll = scroll.follow;

  useEffect(() => {
    return () => {
      if (gTimeoutRef.current) {
        clearTimeout(gTimeoutRef.current);
      }
    };
  }, []);

  const scrollBy = (delta: number): void => dispatch({ type: "by", delta, maxOffset });
  const cancelPendingG = (): void => {
    setPendingG(false);
    if (gTimeoutRef.current) {
      clearTimeout(gTimeoutRef.current);
      gTimeoutRef.current = null;
    }
  };

  useInput((input, key) => {
    const wheel = parseWheelEvent(input);
    if (wheel === "up") {
      scrollBy(-WHEEL_LINES);
      cancelPendingG();
      return;
    }
    if (wheel === "down") {
      scrollBy(WHEEL_LINES);
      cancelPendingG();
      return;
    }

    if (key.upArrow || input === "k") {
      scrollBy(-1);
      cancelPendingG();
    } else if (key.downArrow || input === "j") {
      scrollBy(1);
      cancelPendingG();
    } else if (key.pageUp) {
      scrollBy(-visibleLines);
      cancelPendingG();
    } else if (key.pageDown) {
      scrollBy(visibleLines);
      cancelPendingG();
    } else if (input === "g") {
      if (pendingG) {
        dispatch({ type: "top" });
        cancelPendingG();
      } else {
        setPendingG(true);
        gTimeoutRef.current = setTimeout(() => {
          setPendingG(false);
          gTimeoutRef.current = null;
        }, 500);
      }
    } else if (input === "G") {
      dispatch({ type: "bottom", maxOffset });
      cancelPendingG();
    }
  });

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
    <Box borderStyle="single" flexDirection="column" flexGrow={1} height={height} overflow="hidden" paddingX={1}>
      <Box justifyContent="space-between" gap={1} height={1} flexShrink={0}>
        <Text bold wrap="truncate-end">
          📋 Logs {logs.length > 0 && <Text dimColor>({logs.length} entries)</Text>}
        </Text>
        <Text dimColor wrap="truncate-end">
          {hasMoreAbove || hasMoreBelow ? "↑/↓ scroll " : ""}
          {autoScroll ? "(auto) " : ""}l hide
        </Text>
      </Box>

      {indicatorLines === 2 && hasMoreAbove && <Text dimColor>↑ {aboveCount} more above</Text>}

      {indicatorLines === 1 && (hasMoreAbove || hasMoreBelow) && (
        <Text dimColor wrap="truncate">
          {[hasMoreAbove ? `↑ ${aboveCount} more above` : "", hasMoreBelow ? `↓ ${belowCount} more below` : ""]
            .filter(Boolean)
            .join("  ")}
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

      {indicatorLines === 2 && hasMoreBelow && <Text dimColor>↓ {belowCount} more below</Text>}
    </Box>
  );
};

export const CollapsedLogLine: React.FC<{ logs: LogEntry[]; expandKey: string }> = React.memo(({ logs, expandKey }) => {
  const latest = logs[logs.length - 1];
  const color = latest?.level === "error" ? "red" : latest?.level === "warn" ? "yellow" : undefined;
  return (
    <Box height={1} flexShrink={0} paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold>📋 Logs</Text>{" "}
        <Text dimColor>
          ({logs.length} entries, {expandKey} to expand)
        </Text>
        {latest && (
          <>
            {" "}
            <Text color={color}>{latest.message}</Text>
          </>
        )}
      </Text>
    </Box>
  );
});
CollapsedLogLine.displayName = "CollapsedLogLine";

const samePanelProps = (prev: LogPanelProps, next: LogPanelProps): boolean =>
  prev.logs === next.logs && prev.height === next.height && prev.scroll[0] === next.scroll[0];

export default React.memo(LogPanel, samePanelProps);
