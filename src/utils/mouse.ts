const ESC = String.fromCharCode(27);

export const MOUSE_TRACKING_ENABLE = `${ESC}[?1000h${ESC}[?1006h`;
export const MOUSE_TRACKING_DISABLE = `${ESC}[?1006l${ESC}[?1000l`;

const SGR_MOUSE_PATTERN = new RegExp(`^(?:${ESC})?\\[<(\\d+);(\\d+);(\\d+)[Mm]$`);

const WHEEL_FLAG = 0b100_0000;
const BUTTON_MASK = 0b11;

export type WheelDirection = "up" | "down";

export function isMouseSequence(input: string): boolean {
  return SGR_MOUSE_PATTERN.test(input);
}

export function parseWheelEvent(input: string): WheelDirection | null {
  const match = SGR_MOUSE_PATTERN.exec(input);
  if (!match) return null;

  const button = Number.parseInt(match[1], 10);
  if (!Number.isFinite(button) || (button & WHEEL_FLAG) === 0) return null;

  switch (button & BUTTON_MASK) {
    case 0:
      return "up";
    case 1:
      return "down";
    default:
      return null;
  }
}

export interface MouseTrackingStream {
  write(data: string): unknown;
}

export interface MouseTrackingExitTarget {
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
}

export interface MouseTracking {
  enable(): void;
  disable(): void;
}

export function createMouseTracking(
  stream: MouseTrackingStream,
  exitTarget: MouseTrackingExitTarget = process,
): MouseTracking {
  let active = false;

  const restore = (): void => {
    if (!active) return;
    active = false;
    try {
      stream.write(MOUSE_TRACKING_DISABLE);
    } catch {}
  };

  const onProcessExit = (): void => restore();

  return {
    enable(): void {
      if (active) return;
      active = true;
      exitTarget.once("exit", onProcessExit);
      try {
        stream.write(MOUSE_TRACKING_ENABLE);
      } catch {}
    },
    disable(): void {
      if (!active) return;
      restore();
      exitTarget.removeListener("exit", onProcessExit);
    },
  };
}
