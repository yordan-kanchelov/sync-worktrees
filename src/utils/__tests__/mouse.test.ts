import { describe, expect, it, vi } from "vitest";

import {
  MOUSE_TRACKING_DISABLE,
  MOUSE_TRACKING_ENABLE,
  createMouseTracking,
  isMouseSequence,
  parseWheelEvent,
} from "../mouse";

import type { MouseTrackingExitTarget } from "../mouse";

const recordingStream = (): { write: (data: string) => void; written: string[] } => {
  const written: string[] = [];
  return { write: (data: string): void => void written.push(data), written };
};

const recordingExitTarget = (): MouseTrackingExitTarget & { listeners: Array<() => void> } => {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    once: (_event: "exit", listener: () => void): void => void listeners.push(listener),
    removeListener: (_event: "exit", listener: () => void): void => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
};

const ESC = String.fromCharCode(27);
// Ink strips the leading ESC before handing the sequence to useInput, so the
// stripped form is what components actually see. The raw form is checked too.
const sgr = (button: number, column = 10, row = 5, final = "M"): string => `[<${button};${column};${row}${final}`;
const rawSgr = (button: number): string => `${ESC}[<${button};10;5M`;

describe("mouse", () => {
  describe("parseWheelEvent", () => {
    it("reads wheel up and wheel down", () => {
      expect(parseWheelEvent(sgr(64))).toBe("up");
      expect(parseWheelEvent(sgr(65))).toBe("down");
    });

    it("reads a wheel release report the same way", () => {
      expect(parseWheelEvent(sgr(64, 1, 1, "m"))).toBe("up");
    });

    // Shift/meta/ctrl are OR'd into the same field, so a modifier-held scroll
    // must still scroll rather than fall through to key handling.
    it("ignores modifier bits riding along with the button", () => {
      expect(parseWheelEvent(sgr(64 + 4))).toBe("up"); // shift
      expect(parseWheelEvent(sgr(65 + 8))).toBe("down"); // meta
      expect(parseWheelEvent(sgr(65 + 16))).toBe("down"); // ctrl
      expect(parseWheelEvent(sgr(64 + 4 + 8 + 16))).toBe("up");
    });

    it("returns null for clicks, horizontal wheel and plain text", () => {
      expect(parseWheelEvent(sgr(0))).toBeNull(); // left button
      expect(parseWheelEvent(sgr(2))).toBeNull(); // right button
      expect(parseWheelEvent(sgr(66))).toBeNull(); // wheel left
      expect(parseWheelEvent(sgr(67))).toBeNull(); // wheel right
      expect(parseWheelEvent("j")).toBeNull();
      expect(parseWheelEvent("")).toBeNull();
      expect(parseWheelEvent(`${ESC}[B`)).toBeNull();
    });

    it("accepts the raw sequence with its ESC still attached", () => {
      expect(parseWheelEvent(rawSgr(64))).toBe("up");
      expect(parseWheelEvent(rawSgr(65))).toBe("down");
    });

    it("does not match a truncated or trailing-garbage sequence", () => {
      expect(parseWheelEvent("[<64;10;5")).toBeNull();
      expect(parseWheelEvent("[<64;10;5Mx")).toBeNull();
    });
  });

  describe("isMouseSequence", () => {
    it("recognizes every SGR mouse report, not just the wheel", () => {
      expect(isMouseSequence(sgr(64))).toBe(true);
      expect(isMouseSequence(sgr(0))).toBe(true);
      expect(isMouseSequence(sgr(0, 1, 1, "m"))).toBe(true);
    });

    // Typed characters reach useInput one at a time, so a person typing "[" then
    // "<" into a filter must never be swallowed as a mouse event.
    it("leaves ordinary input alone", () => {
      expect(isMouseSequence("j")).toBe(false);
      expect(isMouseSequence("<")).toBe(false);
      expect(isMouseSequence("[")).toBe(false);
      expect(isMouseSequence("[<")).toBe(false);
      expect(isMouseSequence("[<64")).toBe(false);
      expect(isMouseSequence(`${ESC}[B`)).toBe(false);
      expect(isMouseSequence("")).toBe(false);
    });
  });

  it("pairs enable and disable so the terminal is left as it was found", () => {
    expect(MOUSE_TRACKING_ENABLE).toContain("[?1000h");
    expect(MOUSE_TRACKING_ENABLE).toContain("[?1006h");
    expect(MOUSE_TRACKING_DISABLE).toContain("[?1000l");
    expect(MOUSE_TRACKING_DISABLE).toContain("[?1006l");
  });

  describe("createMouseTracking", () => {
    it("writes the enable sequence once and the disable sequence once", () => {
      const stream = recordingStream();
      const exitTarget = recordingExitTarget();
      const tracking = createMouseTracking(stream, exitTarget);

      tracking.enable();
      tracking.enable();
      tracking.disable();
      tracking.disable();

      expect(stream.written).toEqual([MOUSE_TRACKING_ENABLE, MOUSE_TRACKING_DISABLE]);
      expect(exitTarget.listeners).toEqual([]);
    });

    it("never writes the disable sequence when tracking was never enabled", () => {
      const stream = recordingStream();
      const exitTarget = recordingExitTarget();

      createMouseTracking(stream, exitTarget).disable();

      expect(stream.written).toEqual([]);
      expect(exitTarget.listeners).toEqual([]);
    });

    // The path that matters when nothing in the app gets to run its teardown:
    // an uncaught exception, or a process.exit from somewhere else entirely.
    it("restores the terminal from a process exit listener", () => {
      const stream = recordingStream();
      const exitTarget = recordingExitTarget();
      const tracking = createMouseTracking(stream, exitTarget);

      tracking.enable();
      expect(exitTarget.listeners).toHaveLength(1);

      for (const listener of [...exitTarget.listeners]) listener();

      expect(stream.written).toEqual([MOUSE_TRACKING_ENABLE, MOUSE_TRACKING_DISABLE]);

      tracking.disable();
      expect(stream.written).toEqual([MOUSE_TRACKING_ENABLE, MOUSE_TRACKING_DISABLE]);
    });

    // The listener is registered with `once` and removed by disable(), so a
    // second restore should not be able to happen - but the sequence must never
    // go out twice if a host re-emits, or the terminal ends up with an extra
    // reset in the middle of whatever runs next.
    it("writes the disable sequence once even if the exit listener fires twice", () => {
      const stream = recordingStream();
      const exitTarget = recordingExitTarget();
      const tracking = createMouseTracking(stream, exitTarget);

      tracking.enable();
      const [listener] = exitTarget.listeners;
      listener();
      listener();

      expect(stream.written).toEqual([MOUSE_TRACKING_ENABLE, MOUSE_TRACKING_DISABLE]);
    });

    it("still arms the exit restore when the enable write throws", () => {
      const written: string[] = [];
      let failNext = true;
      const stream = {
        write: (data: string): void => {
          if (failNext) {
            failNext = false;
            throw new Error("EPIPE");
          }
          written.push(data);
        },
      };
      const exitTarget = recordingExitTarget();
      const tracking = createMouseTracking(stream, exitTarget);

      expect(() => tracking.enable()).not.toThrow();
      expect(exitTarget.listeners).toHaveLength(1);

      tracking.disable();
      expect(written).toEqual([MOUSE_TRACKING_DISABLE]);
    });

    it("swallows a disable write that throws so teardown continues", () => {
      const stream = {
        write: vi.fn((): void => {
          throw new Error("stream destroyed");
        }),
      };
      const exitTarget = recordingExitTarget();
      const tracking = createMouseTracking(stream, exitTarget);

      tracking.enable();
      expect(() => tracking.disable()).not.toThrow();
      expect(exitTarget.listeners).toEqual([]);
    });
  });
});
