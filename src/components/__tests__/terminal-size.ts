import type { EventEmitter } from "node:events";

export function resizeTerminal(stdout: EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, "columns", { configurable: true, get: () => columns });
  Object.defineProperty(stdout, "rows", { configurable: true, get: () => rows });
  stdout.emit("resize");
}

export function frameLines(frame: string | undefined): string[] {
  return (frame ?? "").split("\n");
}

export function borderWidths(frame: string | undefined): number[] {
  return frameLines(frame)
    .map((line) => line.trim())
    .filter((line) => /^[╭╔┌]/.test(line))
    .map((line) => [...line].length);
}
