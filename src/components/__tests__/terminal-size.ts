import type { EventEmitter } from "node:events";

/**
 * Give an ink-testing-library stdout a terminal size and tell Ink about it.
 * The testing stdout is always 100 columns and has no rows, so the height falls
 * back to whatever the environment reports; tests of the layout pin both.
 */
export function resizeTerminal(stdout: EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, "columns", { configurable: true, get: () => columns });
  Object.defineProperty(stdout, "rows", { configurable: true, get: () => rows });
  stdout.emit("resize");
}

/** The lines of a frame, for measuring it against the terminal. */
export function frameLines(frame: string | undefined): string[] {
  return (frame ?? "").split("\n");
}

/** The widest box-drawing border in a frame: the one line that measures a box exactly. */
export function borderWidths(frame: string | undefined): number[] {
  return frameLines(frame)
    .map((line) => line.trim())
    .filter((line) => /^[╭╔┌]/.test(line))
    .map((line) => [...line].length);
}
