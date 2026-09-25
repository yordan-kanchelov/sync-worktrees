import { describe, expect, it } from "vitest";

import { getErrorMessage } from "../errors";

describe("getErrorMessage", () => {
  it("returns an Error's message", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads the message of an error-shaped object", () => {
    expect(getErrorMessage({ message: "from an object" })).toBe("from an object");
    expect(getErrorMessage({ message: 42 })).toBe("42");
  });

  it("stringifies anything else", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage(null)).toBe("null");
  });
});
