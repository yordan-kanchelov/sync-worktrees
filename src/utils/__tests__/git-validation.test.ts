import { describe, expect, it } from "vitest";

import { isGitCreatableBranchName, isGitObjectId, isValidGitBranchName } from "../git-validation";

describe("isValidGitBranchName", () => {
  it("accepts a simple name", () => {
    expect(isValidGitBranchName("feature/foo")).toEqual({ valid: true });
  });

  it.each([
    ["empty", "", "empty"],
    ["whitespace only", "   ", "empty"],
    ["leading dash", "-D", "start with '-'"],
    ["ends with .lock", "feature.lock", ".lock"],
    ["contains ..", "foo..bar", "'..'"],
    ["contains @{", "foo@{bar}", "'@{'"],
    ["leading dot", ".hidden", "start or end with '.'"],
    ["trailing dot", "hidden.", "start or end with '.'"],
    ["double slash", "feature//foo", "consecutive slashes"],
    ["control char", "foo\x00bar", "invalid characters"],
    ["has tilde", "feature~1", "invalid characters"],
    ["has colon", "feature:1", "invalid characters"],
    ["has question", "feature?", "invalid characters"],
  ])("rejects %s", (_label, name, fragment) => {
    const result = isValidGitBranchName(name);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(fragment);
  });
});

// The bound that matters for values read back out of a trash manifest: every
// name git itself can create must stay accepted, because a rejected manifest
// is never listed, restored or reaped again. Each verdict below was measured
// against `git check-ref-format --branch` and `git branch -- <name> <sha>` on
// git 2.43.0.
describe("isGitCreatableBranchName", () => {
  it.each([
    "main",
    "feature/x.y",
    "release-1.0",
    "team/area/sub/thing",
    "fonctionnalité/日本語",
    "wip-",
    "feature/x.lock.y",
    "v1.2.3",
    "_leading-underscore",
    // Accepted by `git branch` even though this tool refuses to create one, so
    // an entry trashed from such a branch stays restorable.
    "@",
  ])("accepts %s, which git creates", (name) => {
    expect(isGitCreatableBranchName(name)).toBe(true);
  });

  it.each(["-m", "--delete", "-D", "a..b", "feature@{1}", "feature/x.lock", ".hidden", "a//b", "a b", "", "   "])(
    "rejects %s, which git refuses",
    (name) => {
      expect(isGitCreatableBranchName(name)).toBe(false);
    },
  );
});

describe("isGitObjectId", () => {
  it.each(["a1b2c3d4".repeat(5), "a".repeat(64), "deadbeef", "ABCDEF12"])("accepts the object id %s", (value) => {
    expect(isGitObjectId(value)).toBe(true);
  });

  // "-deadbeef" and " deadbeef" are the cases an unanchored pattern lets
  // through: both contain a run of hex, and the first is exactly the
  // option-shaped value git would permute into a switch.
  it.each([
    "-m",
    "-d",
    "--",
    "-deadbeef",
    " deadbeef",
    "deadbeef ",
    "refs/heads/main",
    "zzzzzz",
    "",
    "a".repeat(65),
    "abc 123",
    "abc\n",
  ])("rejects %s", (value) => {
    expect(isGitObjectId(value)).toBe(false);
  });
});

describe("isGitCreatableBranchName matches what git itself creates", () => {
  // Regression: these are names `git branch` creates and
  // `git check-ref-format --branch` approves. The first version of this
  // predicate delegated to the stricter creation-time validator, which rejects
  // any component ending in a dot — so a repository carrying `v1./x` in from a
  // remote would have had its trash entry permanently unlistable,
  // unrestorable and unreapable after an upgrade.
  it.each(["v1./x", "a./b", "release-1.0./rc", "team./proj", "a.b.c", "feature/x.y", "@"])(
    "accepts %s, which git accepts",
    (name) => {
      expect(isGitCreatableBranchName(name)).toBe(true);
    },
  );

  // A bare dash is the canonical option-shaped name and the whole reason this
  // predicate exists; git branch refuses it too.
  it.each([
    "-",
    "--",
    "-m",
    "a..b",
    "a@{0}",
    "x.lock",
    "a/x.lock",
    ".hidden/x",
    "a/.b",
    "trailing.",
    "a b",
    "a~b",
    "",
    "a//b",
    "/a",
    "a/",
  ])("rejects %s, which git branch refuses", (name) => {
    expect(isGitCreatableBranchName(name)).toBe(false);
  });
});
