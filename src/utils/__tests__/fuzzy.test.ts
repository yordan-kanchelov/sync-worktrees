import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence case-insensitively and reports where", () => {
    const match = fuzzyMatch("FAu", "repo › feature/auth");
    expect(match).not.toBeNull();
    expect(match?.positions.map((p) => "repo › feature/auth"[p]).join("")).toBe("fau");
  });

  it("rejects text that does not contain every character in order", () => {
    expect(fuzzyMatch("xyz", "repo › main")).toBeNull();
    expect(fuzzyMatch("niam", "repo › main")).toBeNull();
  });

  it("matches everything with an empty or blank query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("prefers the word over scattered letters", () => {
    // `main` inside `my-app › main`: the `m` of `my` is the first occurrence,
    // but the best match is the whole word at the end.
    const match = fuzzyMatch("main", "my-app › main");
    expect(match?.positions).toEqual([9, 10, 11, 12]);
  });

  it("requires every whitespace-separated term, in any order", () => {
    expect(fuzzyMatch("auth api", "api › feature/auth")).not.toBeNull();
    expect(fuzzyMatch("auth web", "api › feature/auth")).toBeNull();
  });

  it("does not report a position twice when terms overlap", () => {
    const match = fuzzyMatch("a a", "api");
    expect(match?.positions).toEqual([0]);
  });
});

describe("fuzzyFilter", () => {
  const labels = ["web › main", "api › feature/login", "api › main", "web › fix-mail-address"];

  it("keeps the given order for an empty query", () => {
    expect(fuzzyFilter(labels, "", (l) => l).map((r) => r.item)).toEqual(labels);
  });

  it("ranks consecutive and word-start matches above scattered ones", () => {
    const ranked = fuzzyFilter(labels, "main", (l) => l).map((r) => r.item);
    expect(ranked.slice(0, 2).sort()).toEqual(["api › main", "web › main"]);
    // `m-a-i-l` then `...` scatters `main` across a longer label.
    expect(ranked).not.toContain("api › feature/login");
  });

  it("uses both terms to pick the repository", () => {
    expect(fuzzyFilter(labels, "api main", (l) => l).map((r) => r.item)).toEqual(["api › main"]);
  });

  it("breaks ties by length and then by original order", () => {
    const ranked = fuzzyFilter(["b › x", "a › x", "a › x-long"], "x", (l) => l).map((r) => r.item);
    expect(ranked).toEqual(["b › x", "a › x", "a › x-long"]);
  });

  it("scores a prefix match above the same letters mid-word", () => {
    const ranked = fuzzyFilter(["repo › relay", "repo › dev"], "dev", (l) => l).map((r) => r.item);
    expect(ranked[0]).toBe("repo › dev");
    const [top] = fuzzyFilter(["x › undevelop", "x › develop"], "dev", (l) => l);
    expect(top.item).toBe("x › develop");
  });
});
