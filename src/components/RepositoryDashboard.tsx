import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useWindowSize } from "ink";

import { computeNextSyncTime } from "./StatusBar";
import { DASHBOARD_CHROME_ROWS, dashboardColumns, formatAge, formatUntil } from "./layout";

import type { DashboardColumn } from "./layout";
import type { RepositoryDashboardRow, RepositoryRunState } from "../utils/app-events";

/** How often the age and next-run columns are recomputed. */
export const DASHBOARD_REFRESH_MS = 15_000;

/** Columns the table spends outside its cells: the border and `paddingX={1}`. */
const FRAME_COLUMNS = 4;

type Color = "green" | "yellow" | "red";

const STATES: Record<RepositoryRunState, { icon: string; label: string; color: Color }> = {
  idle: { icon: "●", label: "idle", color: "green" },
  syncing: { icon: "⟳", label: "syncing", color: "yellow" },
  failed: { icon: "✗", label: "failed", color: "red" },
  skipped: { icon: "⚠", label: "skipped", color: "yellow" },
};

const HEADINGS: Record<DashboardColumn, string> = {
  state: "STATE",
  name: "REPOSITORY",
  result: "LAST RESULT",
  age: "SYNCED",
  worktrees: "WT",
  changes: "CHANGES",
  next: "NEXT",
};

const RIGHT_ALIGNED: ReadonlySet<DashboardColumn> = new Set(["worktrees"]);

export interface RepositoryDashboardProps {
  rows: readonly RepositoryDashboardRow[];
  /** Rows the table may take, border and headings included. */
  height: number;
  /** For tests: how often the relative times are recomputed. */
  refreshMs?: number;
}

function changesCell(changes: RepositoryDashboardRow["changes"]): string {
  if (changes === null) return "–";
  if (changes.dirty === 0 && changes.unpushed === 0) return "✓";
  return [changes.dirty > 0 ? `M${changes.dirty}` : "", changes.unpushed > 0 ? `↑${changes.unpushed}` : ""]
    .filter(Boolean)
    .join(" ");
}

function cell(row: RepositoryDashboardRow, column: DashboardColumn, now: number): { text: string; color?: Color } {
  switch (column) {
    case "state": {
      const state = STATES[row.state];
      return { text: `${state.icon} ${state.label}`, color: state.color };
    }
    case "name":
      return { text: row.name };
    case "result":
      return { text: row.lastResult ?? "–", color: row.state === "failed" ? "red" : undefined };
    case "age":
      return { text: row.lastSyncAt === null ? "–" : formatAge(row.lastSyncAt, now) };
    case "worktrees":
      return { text: row.worktrees === null ? "–" : String(row.worktrees) };
    case "changes":
      return {
        text: changesCell(row.changes),
        color: row.changes && (row.changes.dirty > 0 || row.changes.unpushed > 0) ? "yellow" : undefined,
      };
    case "next": {
      const next = row.schedule ? computeNextSyncTime([row.schedule], new Date(now)) : null;
      return { text: next ? formatUntil(next.getTime(), now) : "–" };
    }
  }
}

/**
 * The home screen's repository table: one row per repository with what it is
 * doing, how its last sync went and how long ago, its worktrees, and when it
 * runs next. It draws what the service sent and a clock; it never asks git.
 */
const RepositoryDashboard: React.FC<RepositoryDashboardProps> = ({
  rows,
  height,
  refreshMs = DASHBOARD_REFRESH_MS,
}) => {
  const { columns: terminalColumns } = useWindowSize();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, rows]);

  // At least the heading's width, while the result column can spare it.
  const longestName = useMemo(
    () => rows.reduce((longest, row) => Math.max(longest, [...row.name].length), HEADINGS.name.length),
    [rows],
  );
  const { columns, widths } = dashboardColumns(terminalColumns - FRAME_COLUMNS, longestName);

  // Every row that fits; when they do not all fit, the last line counts the
  // rest -- and names what among them needs a look.
  const room = Math.max(1, height - DASHBOARD_CHROME_ROWS);
  const overflow = rows.length > room;
  const shown = overflow ? rows.slice(0, room - 1) : rows;
  const hidden = rows.slice(shown.length);
  const hiddenFailed = hidden.filter((row) => row.state === "failed").length;
  const hiddenSyncing = hidden.filter((row) => row.state === "syncing").length;
  const overflowNote = [
    `… ${hidden.length} more`,
    hiddenFailed > 0 ? `${hiddenFailed} failed` : "",
    hiddenSyncing > 0 ? `${hiddenSyncing} syncing` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const renderCells = (key: string, cells: Array<{ text: string; color?: Color; bold?: boolean; dim?: boolean }>) => (
    <Box key={key} gap={1} height={1}>
      {columns.map((column, index) => {
        const content = cells[index];
        return (
          <Box
            key={column}
            width={widths[column]}
            flexShrink={0}
            justifyContent={RIGHT_ALIGNED.has(column) ? "flex-end" : "flex-start"}
          >
            <Text wrap="truncate-end" color={content.color} bold={content.bold} dimColor={content.dim}>
              {content.text}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  return (
    <Box borderStyle="single" flexDirection="column" height={height} overflow="hidden" paddingX={1} flexShrink={0}>
      {renderCells(
        "headings",
        columns.map((column) => ({ text: HEADINGS[column], bold: true, dim: true })),
      )}
      {shown.map((row) =>
        renderCells(
          `repo-${row.name}`,
          columns.map((column) => cell(row, column, now)),
        ),
      )}
      {overflow && (
        <Text dimColor wrap="truncate-end">
          {overflowNote}
        </Text>
      )}
    </Box>
  );
};

// Memoised: the App re-renders on every log flush, and none of that is here.
export default React.memo(RepositoryDashboard);
