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

    it("warns when explicit cone is auto-promoted", () => {
      service.resolveMode({ include: ["/*"], exclude: ["docs"], mode: "cone" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("auto-promoting"));
    });

    it("does not warn when mode is unset and auto-promoted", () => {
      service.resolveMode({ include: ["/*"], exclude: ["docs"] });
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
  });
});
