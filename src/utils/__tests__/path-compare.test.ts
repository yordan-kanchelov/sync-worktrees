import { describe, expect, it } from "vitest";

import { isCaseInsensitiveFs, normalizePathForCompare, pathsEqual } from "../path-compare";

describe("isCaseInsensitiveFs", () => {
  it("returns true for darwin", () => {
    expect(isCaseInsensitiveFs("darwin")).toBe(true);
  });

  it("returns true for win32", () => {
    expect(isCaseInsensitiveFs("win32")).toBe(true);
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

  it("matches mixed case on win32", () => {
    expect(pathsEqual("C:\\Users\\Foo", "c:\\users\\foo", "win32")).toBe(true);
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
