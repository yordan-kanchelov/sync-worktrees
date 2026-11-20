import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "../../errors";
import { sanitizeNameForPath } from "../sanitize-name";

describe("sanitizeNameForPath", () => {
  it("drops trailing dots and spaces and keeps interior ones", () => {
    expect(sanitizeNameForPath("my repo. v1.2 . .")).toBe("my repo. v1.2");
    expect(sanitizeNameForPath("app")).toBe("app");
  });

  it("drops leading dots and replaces separators and reserved characters", () => {
    expect(sanitizeNameForPath("..hidden/part\\x:y")).toBe("hidden-part-x_y");
  });

  it("rejects a name that sanitizes to nothing", () => {
    expect(() => sanitizeNameForPath(" .. . ")).toThrow(ConfigValidationError);
  });

  it("handles a long run of dots in the middle of a name in linear time", () => {
    const name = `a${".".repeat(200_000)}b`;
    const startedAt = performance.now();
    expect(sanitizeNameForPath(name)).toBe(name);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  }, 60_000);
});
