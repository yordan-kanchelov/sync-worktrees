import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { parseWheelEvent } from "../utils/mouse";
import type { LogEntry } from "./App";

// One notch of the wheel moves this many lines. Matches what most terminals
// send per detent, so a flick covers ground without overshooting.
const WHEEL_LINES = 3;

export interface LogPanelProps {
  logs: LogEntry[];
  height: number;
  isActive: boolean;
}

const LogPanel: React.FC<LogPanelProps> = ({ logs, height, isActive }) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [pendingG, setPendingG] = useState(false);
  const gTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const borderLines = 2;
  const headerLine = 1;
  const visibleLines = Math.max(1, height - borderLines - headerLine);
  const maxOffset = Math.max(0, logs.length - visibleLines);

  useEffect(() => {
    if (autoScroll) {
      setScrollOffset(maxOffset);
    }
  }, [logs.length, maxOffset, autoScroll]);

  useEffect(() => {
    return () => {
      if (gTimeoutRef.current) {
        clearTimeout(gTimeoutRef.current);
      }
    };
  }, []);

  // Scrolling to the bottom re-arms auto-scroll, anywhere above it parks there
  // until the reader chooses to come back.
  const scrollBy = useCallback(
    (delta: number) => {
      if (delta < 0) setAutoScroll(false);
      setScrollOffset((prev) => {
        const next = Math.min(maxOffset, Math.max(0, prev + delta));
        if (next >= maxOffset) setAutoScroll(true);
        return next;
      });
    },
    [maxOffset],
  );

  useInput(
    (input, key) => {
      if (!isActive) return;

      // Vim motions and arrows suit some people; the wheel is for everyone
      // else. Ink delivers the whole mouse report as one `input` string, so it
      // is parsed here rather than through a separate stdin listener.
      const wheel = parseWheelEvent(input);
      if (wheel === "up") {
        scrollBy(-WHEEL_LINES);
        setPendingG(false);
        return;
      }
      if (wheel === "down") {
        scrollBy(WHEEL_LINES);
        setPendingG(false);
        return;
      }

      if (key.upArrow || input === "k") {
        setScrollOffset((prev) => Math.max(0, prev - 1));
        setAutoScroll(false);
        setPendingG(false);
      } else if (key.downArrow || input === "j") {
        setScrollOffset((prev) => {
          const newOffset = Math.min(maxOffset, prev + 1);
          if (newOffset >= maxOffset) {
            setAutoScroll(true);
          }
          return newOffset;
        });
        setPendingG(false);
      } else if (key.pageUp) {
        setScrollOffset((prev) => Math.max(0, prev - visibleLines));
        setAutoScroll(false);
        setPendingG(false);
      } else if (key.pageDown) {
        setScrollOffset((prev) => {
          const newOffset = Math.min(maxOffset, prev + visibleLines);
          if (newOffset >= maxOffset) {
            setAutoScroll(true);
          }
          return newOffset;
        });
        setPendingG(false);
      } else if (input === "g") {
        if (pendingG) {
          // gg - go to top
          setScrollOffset(0);
          setAutoScroll(false);
          setPendingG(false);
          if (gTimeoutRef.current) {
            clearTimeout(gTimeoutRef.current);
            gTimeoutRef.current = null;
          }
        } else {
          setPendingG(true);
          gTimeoutRef.current = setTimeout(() => {
            setPendingG(false);
          }, 500);
        }
      } else if (input === "G") {
        setScrollOffset(maxOffset);
        setAutoScroll(true);
        setPendingG(false);
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
