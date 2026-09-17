import React, { useState, useEffect, useRef, useReducer } from "react";
import { Box, Text, useInput } from "ink";
import { parseWheelEvent } from "../utils/mouse";
import type { LogEntry } from "./App";

// One notch of the wheel moves this many lines. Matches what most terminals
// send per detent, so a flick covers ground without overshooting.
const WHEEL_LINES = 3;

// Following the tail and sitting at a chosen offset are one piece of state, not
// two: every position implies whether new entries should pull the view along.
// Keeping them separate meant writing both from one keystroke, and computing the
// second from inside the first's updater — updaters have to be pure, and React
// is free to re-run them.
//
// `offset` is only meaningful while parked. In follow mode the render derives the
// offset from the current maxOffset, so a resize or a burst of new entries can
// never leave the view pointing past the end.
type ScrollState = { follow: boolean; offset: number };

type ScrollAction =
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
      // Landing on the last line re-arms following: the reader chose to come back.
      return { follow: next >= action.maxOffset, offset: next };
    }
  }
}

export interface LogPanelProps {
  logs: LogEntry[];
  height: number;
  isActive: boolean;
}

const LogPanel: React.FC<LogPanelProps> = ({ logs, height, isActive }) => {
  const [scroll, dispatch] = useReducer(scrollReducer, { follow: true, offset: 0 });
  const [pendingG, setPendingG] = useState(false);
  const gTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const borderLines = 2;
  const headerLine = 1;
  // The `↑ N more` / `↓ N more` rows are rows too. They used to render on top
  // of a budget that had already been spent, so a panel asked for `height`
  // rows drew height+1 in follow mode and height+2 parked; the App frame then
  // outgrew the terminal, Ink fell back to clearing and repainting the whole
  // screen on every render, and the top row scrolled off.
  //
  // Both rows are reserved as soon as the log is longer than the panel, rather
  // than each one as it happens to show: a viewport whose size depended on the
  // scroll position would move maxOffset under the reader, and one wheel up
  // followed by one wheel down would no longer land back on the tail.
  const contentLines = Math.max(1, height - borderLines - headerLine);
  // At the smallest height the App will hand out there is one row left over
  // after the header and a single log line, and two indicator rows drawn into
  // it land on top of the header: `📋 Logs (40 entries)` came back as
  // `↑ 33 more aboveries)`. Below that, the two counts share one row.
  const indicatorLines = logs.length > contentLines ? Math.min(2, Math.max(0, contentLines - 1)) : 0;
  const visibleLines = Math.max(1, contentLines - indicatorLines);
  const maxOffset = Math.max(0, logs.length - visibleLines);

  // Derived, never stored: following always renders the tail, and a parked
  // offset is clamped to whatever the panel can currently show.
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

  useInput(
    (input, key) => {
      if (!isActive) return;

      // Vim motions and arrows suit some people; the wheel is for everyone
      // else. Ink delivers the whole mouse report as one `input` string, so it
      // is parsed here rather than through a separate stdin listener.
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
          // gg - go to top
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

  // Fixed height and clipped: the budget above keeps the ordinary frame inside
  // it, and this bounds what it cannot predict -- an entry that still carries a
  // newline, a message Ink wraps -- so the frame can never outgrow the row the
  // App reserved for it.
  return (
    <Box borderStyle="single" flexDirection="column" flexGrow={1} height={height} overflow="hidden" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>📋 Logs {logs.length > 0 && <Text dimColor>({logs.length} entries)</Text>}</Text>
        {isActive && (
          <Text dimColor>
            {hasMoreAbove || hasMoreBelow ? "↑/↓ scroll" : ""} {autoScroll ? "(auto)" : ""}
          </Text>
        )}
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

export default LogPanel;
