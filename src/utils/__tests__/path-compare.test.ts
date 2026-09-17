import { describe, expect, it } from "vitest";

import {
  isCaseInsensitiveFs,
  isPathEqualOrInside,
  isPathStrictlyInside,
  normalizePathForCompare,
  pathsEqual,
} from "../path-compare";

describe("isCaseInsensitiveFs", () => {
  it("returns true for darwin", () => {
    expect(isCaseInsensitiveFs("darwin")).toBe(true);
  });

  it("returns false for linux", () => {
    expect(isCaseInsensitiveFs("linux")).toBe(false);
  });
});

describe("normalizePathForCompare", () => {
  it("lowercases on darwin", () => {
    expect(normalizePathForCompare("/Users/Foo/Bar", "darwin")).toBe("/users/foo/bar");
  });

  it("preserves case on linux", () => {
    expect(normalizePathForCompare("/Users/Foo/Bar", "linux")).toBe("/Users/Foo/Bar");
  });

  it("resolves relative paths", () => {
    const out = normalizePathForCompare("foo/bar", "linux");
    expect(out.endsWith("/foo/bar")).toBe(true);
  });
});

describe("pathsEqual", () => {
  it("matches mixed case on darwin", () => {
    expect(pathsEqual("/Users/Foo/Repo", "/users/foo/repo", "darwin")).toBe(true);
  });

  it("is case-sensitive on linux", () => {
    expect(pathsEqual("/Users/Foo", "/users/foo", "linux")).toBe(false);
  });

  it("matches identical paths on linux", () => {
    expect(pathsEqual("/a/b", "/a/b", "linux")).toBe(true);
  });

  it("normalizes relative vs absolute", () => {
    const rel = "src/foo";
    const abs = `${process.cwd()}/src/foo`;
    expect(pathsEqual(rel, abs, "linux")).toBe(true);
  });
});

describe("isPathStrictlyInside", () => {
  it("is true for a descendant on a segment boundary", () => {
    expect(isPathStrictlyInside("/x/inner", "/x", "linux")).toBe(true);
    expect(isPathStrictlyInside("/x/a/b/c", "/x", "linux")).toBe(true);
  });

  it("is false for a sibling that merely shares a string prefix", () => {
    expect(isPathStrictlyInside("/xy", "/x", "linux")).toBe(false);
    expect(isPathStrictlyInside("/x-bare", "/x", "linux")).toBe(false);
  });

  it("is false for the same path and for the parent of the base", () => {
    expect(isPathStrictlyInside("/x", "/x", "linux")).toBe(false);
    expect(isPathStrictlyInside("/", "/x", "linux")).toBe(false);
  });

  it("treats the filesystem root as containing everything", () => {
    expect(isPathStrictlyInside("/x", "/", "linux")).toBe(true);
  });

  it("folds case on darwin only", () => {
    expect(isPathStrictlyInside("/Users/Me/wt/sub", "/users/me/wt", "darwin")).toBe(true);
    expect(isPathStrictlyInside("/Users/Me/wt/sub", "/users/me/wt", "linux")).toBe(false);
  });
});

describe("isPathEqualOrInside", () => {
  it("is true for the same path and for a descendant", () => {
    expect(isPathEqualOrInside("/x", "/x", "linux")).toBe(true);
    expect(isPathEqualOrInside("/x/inner", "/x", "linux")).toBe(true);
  });

  it("is false for a prefix sibling and for an ancestor", () => {
    expect(isPathEqualOrInside("/xy", "/x", "linux")).toBe(false);
    expect(isPathEqualOrInside("/x", "/x/inner", "linux")).toBe(false);
  });
});
