import { useWindowSize } from "ink";
import type { Key } from "ink";

// Shared sizing for the modals. Every modal used to be a fixed 60/70/78 columns
// with an 8-row list, so a terminal narrower than the box clipped its right
// border and a 24-row one pushed the frame past the screen -- at which point Ink
// stops rendering incrementally and repaints everything on every update.

/** A list never shrinks below this many rows, however small the terminal. */
export const MIN_LIST_ROWS = 1;

/**
 * Below this many rows a modal drops its outer margins and vertical padding:
 * on a 24-row terminal those four rows are most of what its list would get.
 */
export const COMPACT_MODAL_BELOW_ROWS = 30;

/** Narrowest a modal box gets; below this nothing inside it is legible anyway. */
const MIN_MODAL_WIDTH = 24;

/** Columns a modal box spends outside its content: the border and `paddingX={2}`. */
export const MODAL_FRAME_COLUMNS = 6;

/**
 * Rows every modal spends outside its content: the border (2), the title and
 * its margin (2), and the footer and its margin (2) -- plus, unless compact,
 * its outer top and bottom margin (2) and `paddingY={1}` (2).
 */
const COMPACT_CHROME_ROWS = 6;
const ROOMY_CHROME_ROWS = 10;

export interface ModalLayout {
  /** Width of the modal box, never wider than the terminal. */
  width: number;
  /** Columns left for content inside the border and padding. */
  innerWidth: number;
  /** Rows the modal may occupy without pushing the frame past the terminal. */
  rows: number;
  /** Rows spent on the border, margins, padding, title and footer. */
  chromeRows: number;
  /** Outer top/bottom margin of the modal. */
  marginY: number;
  /** Vertical padding inside the border. */
  paddingY: number;
}

export function modalWidth(preferred: number, columns: number): number {
  return Math.max(MIN_MODAL_WIDTH, Math.min(preferred, columns - 2));
}

/**
 * The box width and row budget for a modal. `availableRows` is what the App has
 * left once the status bar is drawn; a modal rendered on its own gets the whole
 * terminal.
 */
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

/**
 * How many items of a `total`-long list to show in `room` rows. A list that
 * fits is shown whole; one that does not gives up two rows to its `...`
 * markers, reserved up front so the window does not change size as the
 * selection moves.
 */
export function listRowsFor(room: number, total: number): number {
  if (total <= room) return Math.max(1, total);
  return Math.max(MIN_LIST_ROWS, room - 2);
}

/** The `[start, end)` slice of a list that keeps `selected` roughly centred. */
export function listWindow(selected: number, total: number, visible: number): { start: number; end: number } {
  const half = Math.floor(visible / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(total, start + visible);
  if (end - start < visible) {
    start = Math.max(0, end - visible);
  }
  return { start, end };
}

/** Rows a line of plain text takes when Ink word-wraps it to `width` columns. */
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

// Ctrl-P / Ctrl-N move through the wizards' lists the way they do in a shell or
// an editor, so the hands can stay on the home row. Neither can be typed into a
// filter: the filters only take input that arrives without Ctrl.
export function isListUp(input: string, key: Key): boolean {
  return key.upArrow || (key.ctrl && input === "p");
}

export function isListDown(input: string, key: Key): boolean {
  return key.downArrow || (key.ctrl && input === "n");
}

// The home screen: the repository table on top, the log under it, the status
// bar at the bottom. The table and the log split whatever the status bar leaves.

/** Rows the repository table spends outside its rows: the border (2) and the column headings (1). */
export const DASHBOARD_CHROME_ROWS = 3;
/** The smallest log panel still worth drawing: the border (2), its heading (1) and one line. */
export const LOG_MIN_ROWS = 4;
/** A collapsed log is one line: its heading and the latest entry. */
export const LOG_COLLAPSED_ROWS = 1;
/** How much `+` / `-` grow or shrink the log panel by. */
export const LOG_RESIZE_STEP = 3;
/** Left to itself, the table never squeezes the log below this. */
const LOG_COMFORT_ROWS = 8;

export interface LogSizePreference {
  /** `l` folded the log to one line. */
  collapsed: boolean;
  /** Rows `+` / `-` asked for, or null to let the table have what it needs first. */
  rows: number | null;
}

export interface HomeLayout {
  /** Rows of the repository table, chrome included; 0 hides it. */
  dashboardRows: number;
  /** Rows of the log: a panel, or a single line when collapsed. */
  logRows: number;
  logCollapsed: boolean;
}

/**
 * Split `available` rows between the repository table and the log. The table
 * comes first -- it is the home screen -- but by default it leaves the log a
 * readable panel. When there is not room for a table row and a log panel both,
 * the log folds to one line, and below that the table goes.
 */
export function homeLayout(available: number, repositoryCount: number, preference: LogSizePreference): HomeLayout {
  const rows = Math.max(1, available);
  const wanted = repositoryCount > 0 ? DASHBOARD_CHROME_ROWS + repositoryCount : 0;
  // A table without a single repository row is not worth its border.
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
  // Left to itself, a table squeezed below one row by the even split still
  // fits beside a folded log: fold the log rather than lose the table. (A size
  // `+` / `-` asked for is kept: it is how the log takes the whole screen.)
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

/** Widths of the fixed columns, headings included. */
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
/** What goes first as the terminal narrows; the state and the name always stay. */
const DROP_ORDER: readonly DashboardColumn[] = ["next", "worktrees", "changes", "age", "result"];
const COLUMN_ORDER: readonly DashboardColumn[] = ["state", "name", "result", "age", "worktrees", "changes", "next"];

export interface DashboardColumns {
  columns: DashboardColumn[];
  widths: Record<DashboardColumn, number>;
}

const fixedWidth = (column: DashboardColumn): number =>
  column === "name" || column === "result" ? 0 : DASHBOARD_FIXED_WIDTHS[column];

/**
 * Which of the table's columns fit `innerWidth`, and how wide each is. The
 * result column shrinks first, then whole columns go in DROP_ORDER. Every cell
 * truncates, so a row stays one line whatever the terminal.
 */
export function dashboardColumns(innerWidth: number, longestName: number): DashboardColumns {
  const width = Math.max(1, innerWidth);
  // One space between neighbouring columns.
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

/** How long ago `then` was, the way the table's age column says it. */
export function formatAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** How long until `then`, for the table's next-run column. */
export function formatUntil(then: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((then - now) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
