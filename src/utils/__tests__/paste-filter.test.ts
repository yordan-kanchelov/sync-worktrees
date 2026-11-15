import { describe, expect, it } from "vitest";

import { sanitizePastedFilter } from "../paste-filter";

describe("sanitizePastedFilter", () => {
  it("drops a trailing newline", () => {
    expect(sanitizePastedFilter("main\n")).toBe("main");
    expect(sanitizePastedFilter("main\r\n")).toBe("main");
  });

  it("turns inner line breaks into one space and trims the ends", () => {
    expect(sanitizePastedFilter("  feat\r\n\nauth  ")).toBe("feat auth");
  });

  it("leaves plain text alone", () => {
    expect(sanitizePastedFilter("feature/x")).toBe("feature/x");
  });
});
