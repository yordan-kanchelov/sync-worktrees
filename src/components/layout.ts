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
