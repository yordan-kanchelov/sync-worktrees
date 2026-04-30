import { beforeEach, describe, expect, it, vi } from "vitest";

import { SparseCheckoutService } from "../sparse-checkout.service";

import type { SparseCheckoutConfig } from "../../types";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";

function createMockGit() {
  return {
    raw: vi.fn(),
  } as unknown as SimpleGit & { raw: ReturnType<typeof vi.fn> };
}

describe("SparseCheckoutService", () => {
  let service: SparseCheckoutService;
  let logger: Logger;
  let warnSpy: ReturnType<typeof vi.fn>;
  let mockGit: ReturnType<typeof createMockGit>;

  beforeEach(() => {
    warnSpy = vi.fn();
    logger = {
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    mockGit = createMockGit();
    service = new SparseCheckoutService(logger, () => mockGit);
  });

  describe("resolveMode", () => {
    it("defaults to cone when mode unset, no exclude, no negation", () => {
      expect(service.resolveMode({ include: ["apps", "packages"] })).toBe("cone");
    });

    it("returns no-cone when explicit", () => {
      expect(service.resolveMode({ include: ["apps"], mode: "no-cone" })).toBe("no-cone");
    });

    it("auto-promotes cone to no-cone when exclude present", () => {
      expect(service.resolveMode({ include: ["/*"], exclude: ["docs"] })).toBe("no-cone");
    });

    it("auto-promotes cone to no-cone when include has negation", () => {
      expect(service.resolveMode({ include: ["/*", "!docs"] })).toBe("no-cone");
    });

    it("auto-promotes cone to no-cone when negation pattern has surrounding whitespace", () => {
      expect(service.resolveMode({ include: ["/*", "  !docs"] })).toBe("no-cone");
    });

    it("warns when explicit cone is auto-promoted", () => {
      service.resolveMode({ include: ["/*"], exclude: ["docs"], mode: "cone" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("auto-promoting"));
    });

    it("does not warn when mode is unset and auto-promoted", () => {
      service.resolveMode({ include: ["/*"], exclude: ["docs"] });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns only once per config instance even across many calls", () => {
      const cfg: SparseCheckoutConfig = { include: ["/*"], exclude: ["docs"], mode: "cone" };
      service.resolveMode(cfg);
      service.resolveMode(cfg);
      service.buildPatterns(cfg);
      service.buildPatterns(cfg);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateLogger", () => {
    it("redirects subsequent warnings to the new logger", () => {
      const newWarn = vi.fn();
      const newLogger = { info: vi.fn(), warn: newWarn, error: vi.fn(), debug: vi.fn() } as unknown as Logger;
      service.updateLogger(newLogger);
      service.resolveMode({ include: ["/*"], exclude: ["docs"], mode: "cone" });
      expect(newWarn).toHaveBeenCalledWith(expect.stringContaining("auto-promoting"));
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("buildPatterns", () => {
    it("returns include list as-is for cone", () => {
      expect(service.buildPatterns({ include: ["apps", "packages"] })).toEqual(["apps", "packages"]);
    });

    it("appends excludes as !-prefixed lines for no-cone", () => {
      expect(service.buildPatterns({ include: ["/*"], exclude: ["docs", "vendor"] })).toEqual([
        "/*",
        "!docs",
        "!vendor",
      ]);
    });

    it("preserves existing !-prefix on excludes", () => {
      expect(service.buildPatterns({ include: ["/*"], exclude: ["!docs"] })).toEqual(["/*", "!docs"]);
    });

    it("trims whitespace and drops empty entries", () => {
      expect(service.buildPatterns({ include: ["  apps  ", "", "packages"] })).toEqual(["apps", "packages"]);
    });
  });

  describe("applyToWorktree", () => {
    it("runs init --cone then set --cone <patterns> for cone mode", async () => {
      mockGit.raw.mockResolvedValue("");
      await service.applyToWorktree("/wt", { include: ["apps", "packages"] });
      expect(mockGit.raw).toHaveBeenNthCalledWith(1, ["sparse-checkout", "init", "--cone"]);
      expect(mockGit.raw).toHaveBeenNthCalledWith(2, ["sparse-checkout", "set", "--cone", "apps", "packages"]);
    });

    it("runs init --no-cone then set --no-cone <patterns> for no-cone mode", async () => {
      mockGit.raw.mockResolvedValue("");
      await service.applyToWorktree("/wt", { include: ["/*"], exclude: ["docs"] });
      expect(mockGit.raw).toHaveBeenNthCalledWith(1, ["sparse-checkout", "init", "--no-cone"]);
      expect(mockGit.raw).toHaveBeenNthCalledWith(2, ["sparse-checkout", "set", "--no-cone", "/*", "!docs"]);
    });

    it("throws if patterns are empty", async () => {
      await expect(service.applyToWorktree("/wt", { include: ["", "  "] })).rejects.toThrow(/no patterns/);
    });
  });

  describe("readCurrent", () => {
    it("parses sparse-checkout list output to non-empty array", async () => {
      mockGit.raw.mockResolvedValue("apps\npackages\n");
      const out = await service.readCurrent("/wt");
      expect(out).toEqual(["apps", "packages"]);
    });

    it("returns null on empty output", async () => {
      mockGit.raw.mockResolvedValue("");
      expect(await service.readCurrent("/wt")).toBeNull();
    });

    it("returns null when git command fails", async () => {
      mockGit.raw.mockRejectedValue(new Error("not configured"));
      expect(await service.readCurrent("/wt")).toBeNull();
    });

    it("filters comment and blank lines", async () => {
      mockGit.raw.mockResolvedValue("# heading\n\napps\n");
      expect(await service.readCurrent("/wt")).toEqual(["apps"]);
    });
  });

  describe("needsUpdate", () => {
    const cfg: SparseCheckoutConfig = { include: ["apps"] };

    it("returns true when not configured", async () => {
      mockGit.raw.mockResolvedValue("");
      expect(await service.needsUpdate("/wt", cfg)).toBe(true);
    });

    it("returns false when current matches desired (order-insensitive)", async () => {
      mockGit.raw.mockResolvedValue("apps\n");
      expect(await service.needsUpdate("/wt", cfg)).toBe(false);
    });

    it("returns true when patterns differ", async () => {
      mockGit.raw.mockResolvedValue("apps\npackages\n");
      expect(await service.needsUpdate("/wt", cfg)).toBe(true);
    });
  });

  describe("isNarrowing", () => {
    it("returns false when current is null or empty", () => {
      expect(service.isNarrowing(null, ["apps"])).toBe(false);
      expect(service.isNarrowing([], ["apps"])).toBe(false);
    });

    it("returns true when next omits a current pattern", () => {
      expect(service.isNarrowing(["apps", "packages"], ["apps"])).toBe(true);
    });

    it("returns false when next is a superset", () => {
      expect(service.isNarrowing(["apps"], ["apps", "packages"])).toBe(false);
    });

    it("returns false when sets are identical", () => {
      expect(service.isNarrowing(["apps"], ["apps"])).toBe(false);
    });

    it("returns true when an exclude is added (no-cone narrowing)", () => {
      expect(service.isNarrowing(["/*", "!docs"], ["/*", "!docs", "!vendor"])).toBe(true);
    });

    it("returns false when an exclude is removed (no-cone widening)", () => {
      expect(service.isNarrowing(["/*", "!docs", "!vendor"], ["/*", "!docs"])).toBe(false);
    });

    it("returns true when a positive include is removed but negatives are unchanged", () => {
      expect(service.isNarrowing(["/*", "apps", "!docs"], ["/*", "!docs"])).toBe(true);
    });
  });

  describe("patternsEqual", () => {
    it("returns true for identical lists in same order", () => {
      expect(service.patternsEqual(["/*", "!docs"], ["/*", "!docs"])).toBe(true);
    });

    it("returns false when order differs (no-cone semantics depend on order)", () => {
      expect(service.patternsEqual(["/*", "!docs"], ["!docs", "/*"])).toBe(false);
    });

    it("returns false when lengths differ", () => {
      expect(service.patternsEqual(["a"], ["a", "b"])).toBe(false);
    });
  });

  describe("pathsTouchSparse (cone mode)", () => {
    it("returns false when changed paths list is empty", () => {
      expect(service.pathsTouchSparse([], { include: ["src"] })).toBe(false);
    });

    it("returns true when a changed path lies inside an include directory", () => {
      expect(service.pathsTouchSparse(["src/foo.ts"], { include: ["src"] })).toBe(true);
    });

    it("returns false when changed paths are all outside the include directories", () => {
      expect(service.pathsTouchSparse(["lib/foo.ts", "tools/x.ts"], { include: ["src"] })).toBe(false);
    });

    it("treats trailing slash on patterns as equivalent", () => {
      expect(service.pathsTouchSparse(["src/foo.ts"], { include: ["src/"] })).toBe(true);
    });

    it("matches nested include paths exactly", () => {
      expect(service.pathsTouchSparse(["tools/build/x.ts"], { include: ["tools/build"] })).toBe(true);
      expect(service.pathsTouchSparse(["tools/other/x.ts"], { include: ["tools/build"] })).toBe(false);
    });

    it("matches files directly inside ancestors of a nested include (cone keeps parent files)", () => {
      // For include "tools/build", git's cone mode also checks out files directly in "tools/"
      expect(service.pathsTouchSparse(["tools/file.txt"], { include: ["tools/build"] })).toBe(true);
    });

    it("does not match files in sibling directories of an ancestor", () => {
      expect(service.pathsTouchSparse(["other/file.txt"], { include: ["tools/build"] })).toBe(false);
    });

    it("matches direct files of every ancestor for deeply nested includes", () => {
      const cfg = { include: ["a/b/c/d"] };
      expect(service.pathsTouchSparse(["a/x"], cfg)).toBe(true);
      expect(service.pathsTouchSparse(["a/b/x"], cfg)).toBe(true);
      expect(service.pathsTouchSparse(["a/b/c/x"], cfg)).toBe(true);
      expect(service.pathsTouchSparse(["a/b/c/d/x"], cfg)).toBe(true);
      expect(service.pathsTouchSparse(["a/b/d/x"], cfg)).toBe(false);
      expect(service.pathsTouchSparse(["a/b/c/sibling/x"], cfg)).toBe(false);
    });

    it("returns true when a root file is touched (cone always materializes root files)", () => {
      expect(service.pathsTouchSparse(["README.md"], { include: ["src"] })).toBe(true);
    });

    it("does not match a sibling directory whose name shares a prefix", () => {
      expect(service.pathsTouchSparse(["sources/foo.ts"], { include: ["src"] })).toBe(false);
    });

    it("matches when include itself is the exact path", () => {
      expect(service.pathsTouchSparse(["src"], { include: ["src"] })).toBe(true);
    });

    it("returns true (force update) when include list is effectively empty", () => {
      expect(service.pathsTouchSparse(["lib/foo.ts"], { include: ["", "  "] })).toBe(true);
    });

    it("supports multiple include patterns", () => {
      const cfg = { include: ["react-game-client", "jenkins"] };
      expect(service.pathsTouchSparse(["jenkins/Jenkinsfile"], cfg)).toBe(true);
      expect(service.pathsTouchSparse(["autocue/main.ts"], cfg)).toBe(false);
    });
  });

  describe("pathsTouchSparse (no-cone mode)", () => {
    it("returns true conservatively for any non-empty diff (no-cone matching not implemented)", () => {
      const cfg: SparseCheckoutConfig = { include: ["/*"], exclude: ["docs"] };
      expect(service.pathsTouchSparse(["lib/foo.ts"], cfg)).toBe(true);
      expect(service.pathsTouchSparse(["docs/x.md"], cfg)).toBe(true);
    });

    it("still returns false for empty diff in no-cone", () => {
      expect(service.pathsTouchSparse([], { include: ["/*"], exclude: ["docs"] })).toBe(false);
    });
  });
});
