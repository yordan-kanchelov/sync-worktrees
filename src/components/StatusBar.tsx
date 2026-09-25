import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { CronExpressionParser } from "cron-parser";

import type { AppSyncProgress, CronScheduleDisplay, LastSyncOutcome } from "../utils/app-events";

export interface StatusBarProps {
  status: "idle" | "syncing";
  syncProgressEntries?: AppSyncProgress[];
  activeOps?: string[];
  maxProgressLines?: number;
  repositoryCount: number;
  lastSyncTime: Date | null;
  lastSyncOutcome?: LastSyncOutcome | null;
  cronSchedule?: CronScheduleDisplay;
  diskSpaceUsed?: string;
  notice?: string | null;
}

function toScheduleList(cronSchedule: CronScheduleDisplay): string[] {
  if (cronSchedule === undefined) return [];
  return (typeof cronSchedule === "string" ? [cronSchedule] : [...cronSchedule]).filter((s) => s.length > 0);
}

// The earliest next run across every schedule. Repositories on different
// schedules used to hide "Next Sync" altogether; an expression that does not
// parse is left out rather than blanking the ones that do.
export function computeNextSyncTime(schedules: readonly string[], now: Date = new Date()): Date | null {
  let earliest: Date | null = null;
  for (const schedule of schedules) {
    try {
      const next = CronExpressionParser.parse(schedule, { currentDate: now }).next().toDate();
      if (earliest === null || next < earliest) earliest = next;
    } catch {
      // Not a schedule this parser understands; the others still count.
    }
  }
  return earliest;
}

function describeOutcome(outcome: LastSyncOutcome): { text: string; color: "green" | "red" | "yellow" } {
  switch (outcome.kind) {
    case "failed":
      return { text: `✗ ${outcome.count} failed`, color: "red" };
    case "skipped":
      return { text: `⚠ ${outcome.count} skipped`, color: "yellow" };
    default:
      return { text: "✓ OK", color: "green" };
  }
}

const StatusBar: React.FC<StatusBarProps> = ({
  status,
  syncProgressEntries = [],
  activeOps = [],
  maxProgressLines = 2,
  repositoryCount,
  lastSyncTime,
  lastSyncOutcome = null,
  cronSchedule,
  diskSpaceUsed,
  notice = null,
}) => {
  const schedules = toScheduleList(cronSchedule);
  const [nextSyncTime, setNextSyncTime] = useState<Date | null>(() => computeNextSyncTime(schedules));
  // A fresh array on every render; the key is what the effect compares.
  const scheduleKey = schedules.join("\n");

  useEffect(() => {
    const list = scheduleKey === "" ? [] : scheduleKey.split("\n");
    if (list.length === 0) {
      setNextSyncTime(null);
      return undefined;
    }

    setNextSyncTime(computeNextSyncTime(list));
    const timer = setInterval(() => {
      setNextSyncTime(computeNextSyncTime(list));
    }, 60000);

    return () => clearInterval(timer);
  }, [scheduleKey]);

  const formatTime = (date: Date | null): string => {
    if (!date) return "N/A";
    return date.toLocaleTimeString();
  };

  const getStatusColor = (): "green" | "yellow" => {
    return status === "syncing" ? "yellow" : "green";
  };

  const getStatusIcon = (): string => {
    return status === "syncing" ? "⟳" : "●";
  };

  const outcome = lastSyncOutcome ? describeOutcome(lastSyncOutcome) : null;

  const formatProgress = (syncProgress: AppSyncProgress): string => `[${syncProgress.repo}] ${syncProgress.message}`;

  const progressLineCount = Math.max(1, maxProgressLines);
  const visibleProgress = syncProgressEntries.slice(-progressLineCount);

  return (
    <Box borderStyle="single" paddingX={1}>
      <Box flexDirection="column" width="100%">
        <Box justifyContent="space-between">
          <Text bold>
            {getStatusIcon()} Status:{" "}
            <Text color={getStatusColor()}>{status === "syncing" ? "Syncing..." : "Idle"}</Text>
          </Text>
          <Text>
            Repositories:{" "}
            <Text bold color="cyan">
              {repositoryCount}
            </Text>
          </Text>
        </Box>
        <Box justifyContent="space-between">
          <Text>
            Last Sync: <Text color="gray">{formatTime(lastSyncTime)}</Text>
            {outcome && (
              <>
                {" "}
                <Text color={outcome.color}>{outcome.text}</Text>
              </>
            )}
          </Text>
          {schedules.length > 0 && (
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
        {activeOps.map((label, index) => (
          <Box key={`op-${index}`}>
            <Text wrap="truncate">
              <Text color="yellow">⏳ </Text>
              <Text color="yellow">{label}</Text>
            </Text>
          </Box>
        ))}
        <Box justifyContent="space-between">
          <Text>
            Disk Space: <Text color="magenta">{diskSpaceUsed || "Calculating..."}</Text>
          </Text>
          {notice ? (
            <Text color="yellow" wrap="truncate">
              {notice}
            </Text>
          ) : (
            <Text dimColor>
              <Text color="yellow">s</Text>ync <Text color="yellow">c</Text>reate <Text color="yellow">o</Text>pen{" "}
              <Text color="yellow">w</Text>tree <Text color="yellow">x</Text>clean <Text color="yellow">r</Text>eload{" "}
              <Text color="yellow">?</Text>help <Text color="yellow">q</Text>uit
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default StatusBar;
