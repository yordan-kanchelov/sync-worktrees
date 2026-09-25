import { describe, expect, it } from "vitest";

import { colorsEnabled, hasInteractiveTerminal } from "../terminal";

describe("hasInteractiveTerminal", () => {
  it("needs both stdin and stdout to be a TTY", () => {
    expect(hasInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(hasInteractiveTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(hasInteractiveTerminal({ isTTY: true }, {})).toBe(false);
    expect(hasInteractiveTerminal({}, {})).toBe(false);
  });
});

describe("colorsEnabled", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it("follows the stream when nothing is set", () => {
    expect(colorsEnabled({}, tty)).toBe(true);
    expect(colorsEnabled({}, pipe)).toBe(false);
  });

  it("turns colour off for a non-empty NO_COLOR, even on a terminal", () => {
    expect(colorsEnabled({ NO_COLOR: "1" }, tty)).toBe(false);
    // An empty value means unset (https://no-color.org).
    expect(colorsEnabled({ NO_COLOR: "" }, tty)).toBe(true);
  });

  it("lets FORCE_COLOR decide over NO_COLOR and the stream", () => {
    expect(colorsEnabled({ FORCE_COLOR: "1", NO_COLOR: "1" }, pipe)).toBe(true);
    expect(colorsEnabled({ FORCE_COLOR: "" }, pipe)).toBe(true);
    expect(colorsEnabled({ FORCE_COLOR: "0" }, tty)).toBe(false);
    expect(colorsEnabled({ FORCE_COLOR: "false" }, tty)).toBe(false);
  });
});
