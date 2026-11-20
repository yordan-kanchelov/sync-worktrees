import { useWindowSize } from "ink";
import type { Key } from "ink";

export const MIN_LIST_ROWS = 1;

export const COMPACT_MODAL_BELOW_ROWS = 30;

const MIN_MODAL_WIDTH = 24;

export const MODAL_FRAME_COLUMNS = 6;

const COMPACT_CHROME_ROWS = 6;
const ROOMY_CHROME_ROWS = 10;

export interface ModalLayout {
  width: number;
  innerWidth: number;
  rows: number;
  chromeRows: number;
  marginY: number;
  paddingY: number;
}

export function modalWidth(preferred: number, columns: number): number {
  return Math.max(MIN_MODAL_WIDTH, Math.min(preferred, columns - 2));
}

export function useModalLayout(preferredWidth: number, availableRows?: number): ModalLayout {
  const { columns, rows } = useWindowSize();
  const width = modalWidth(preferredWidth, columns);
  const modalRows = availableRows ?? rows;
  const compact = modalRows < COMPACT_MODAL_BELOW_ROWS;
  return {
    width,
    innerWidth: Math.max(1, width - MODAL_FRAME_COLUMNS),
    rows: modalRows,
    chromeRows: compact ? COMPACT_CHROME_ROWS : ROOMY_CHROME_ROWS,
    marginY: compact ? 0 : 1,
    paddingY: compact ? 0 : 1,
  };
}

export function listRowsFor(room: number, total: number): number {
  if (total <= room) return Math.max(1, total);
  return Math.max(MIN_LIST_ROWS, room - 2);
}

export function listWindow(selected: number, total: number, visible: number): { start: number; end: number } {
  const half = Math.floor(visible / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(total, start + visible);
  if (end - start < visible) {
    start = Math.max(0, end - visible);
  }
  return { start, end };
}

export function wrappedRows(text: string, width: number): number {
  if (width <= 0) return 1;
  let rows = 1;
  let column = 0;
  for (const word of text.split(" ")) {
    const length = [...word].length;
    if (column === 0) {
      column = length;
    } else if (column + 1 + length <= width) {
      column += 1 + length;
    } else {
      rows++;
      column = length;
    }
    while (column > width) {
      rows++;
      column -= width;
    }
  }
  return rows;
}

export function isListUp(input: string, key: Key): boolean {
  return key.upArrow || (key.ctrl && input === "p");
}

export function isListDown(input: string, key: Key): boolean {
  return key.downArrow || (key.ctrl && input === "n");
}

export const DASHBOARD_CHROME_ROWS = 3;
export const LOG_MIN_ROWS = 4;
export const LOG_COLLAPSED_ROWS = 1;
export const LOG_RESIZE_STEP = 3;
const LOG_COMFORT_ROWS = 8;

export interface LogSizePreference {
  collapsed: boolean;
  rows: number | null;
}

export interface HomeLayout {
  dashboardRows: number;
  logRows: number;
  logCollapsed: boolean;
}

export function homeLayout(available: number, repositoryCount: number, preference: LogSizePreference): HomeLayout {
  const rows = Math.max(1, available);
  const wanted = repositoryCount > 0 ? DASHBOARD_CHROME_ROWS + repositoryCount : 0;
  const shown = (dashboardRows: number): number => (dashboardRows > DASHBOARD_CHROME_ROWS ? dashboardRows : 0);
  const collapsed = (): HomeLayout => ({
    dashboardRows: shown(Math.min(wanted, rows - LOG_COLLAPSED_ROWS)),
    logRows: LOG_COLLAPSED_ROWS,
    logCollapsed: true,
  });

  if (preference.collapsed) return collapsed();

  const dashboardRows = shown(
    preference.rows === null
      ? Math.min(wanted, Math.max(Math.ceil(rows / 2), rows - LOG_COMFORT_ROWS))
      : Math.min(wanted, rows - preference.rows),
  );
  if (dashboardRows > 0 && rows - dashboardRows < LOG_MIN_ROWS) return collapsed();
  if (
    dashboardRows === 0 &&
    preference.rows === null &&
    wanted > 0 &&
    rows >= DASHBOARD_CHROME_ROWS + 1 + LOG_COLLAPSED_ROWS
  ) {
    return collapsed();
  }
  return { dashboardRows, logRows: rows - dashboardRows, logCollapsed: false };
}

export type DashboardColumn = "state" | "name" | "result" | "age" | "worktrees" | "changes" | "next";

type FixedColumn = "state" | "age" | "worktrees" | "changes" | "next";

export const DASHBOARD_FIXED_WIDTHS: Readonly<Record<FixedColumn, number>> = {
  state: 10,
  age: 8,
  worktrees: 3,
  changes: 7,
  next: 6,
};
const MIN_NAME_WIDTH = 8;
const MAX_NAME_WIDTH = 28;
const MIN_RESULT_WIDTH = 12;
const DROP_ORDER: readonly DashboardColumn[] = ["next", "worktrees", "changes", "age", "result"];
const COLUMN_ORDER: readonly DashboardColumn[] = ["state", "name", "result", "age", "worktrees", "changes", "next"];

export interface DashboardColumns {
  columns: DashboardColumn[];
  widths: Record<DashboardColumn, number>;
}

const fixedWidth = (column: DashboardColumn): number =>
  column === "name" || column === "result" ? 0 : DASHBOARD_FIXED_WIDTHS[column];

export function dashboardColumns(innerWidth: number, longestName: number): DashboardColumns {
  const width = Math.max(1, innerWidth);
  const spent = (list: DashboardColumn[]): number =>
    list.reduce((sum, column) => sum + fixedWidth(column), 0) + (list.length - 1);
  const needed = (list: DashboardColumn[]): number =>
    spent(list) + MIN_NAME_WIDTH + (list.includes("result") ? MIN_RESULT_WIDTH : 0);

  let columns = [...COLUMN_ORDER];
  for (const drop of DROP_ORDER) {
    if (needed(columns) <= width) break;
    columns = columns.filter((column) => column !== drop);
  }

  const flexible = Math.max(1, width - spent(columns));
  const hasResult = columns.includes("result");
  const name = hasResult
    ? Math.max(MIN_NAME_WIDTH, Math.min(Math.max(1, longestName), MAX_NAME_WIDTH, flexible - MIN_RESULT_WIDTH))
    : flexible;
  return {
    columns,
    widths: {
      ...DASHBOARD_FIXED_WIDTHS,
      name: Math.min(name, flexible),
      result: hasResult ? Math.max(1, flexible - name) : 0,
    },
  };
}

export function formatAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatUntil(then: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((then - now) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
