import { filterBranchesByAge, formatDuration, parseDuration } from "../date-filter";

describe("date-filter", () => {
  describe("parseDuration", () => {
    it("should parse hours correctly", () => {
      expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
      expect(parseDuration("1h")).toBe(60 * 60 * 1000);
    });

    it("should parse days correctly", () => {
      expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
      expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
    });

    it("should parse weeks correctly", () => {
      expect(parseDuration("4w")).toBe(4 * 7 * 24 * 60 * 60 * 1000);
      expect(parseDuration("1w")).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should parse months correctly", () => {
      expect(parseDuration("6m")).toBe(6 * 30 * 24 * 60 * 60 * 1000);
      expect(parseDuration("1m")).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it("should parse years correctly", () => {
      expect(parseDuration("2y")).toBe(2 * 365 * 24 * 60 * 60 * 1000);
      expect(parseDuration("1y")).toBe(365 * 24 * 60 * 60 * 1000);
    });

    it("should return null for invalid formats", () => {
      expect(parseDuration("30")).toBeNull();
      expect(parseDuration("d30")).toBeNull();
      expect(parseDuration("30 days")).toBeNull();
      expect(parseDuration("")).toBeNull();
      expect(parseDuration("30x")).toBeNull();
    });
  });

  describe("filterBranchesByAge", () => {
    const now = new Date();
    const dayInMs = 24 * 60 * 60 * 1000;

    const branches = [
      { branch: "main", lastActivity: new Date(now.getTime() - 5 * dayInMs) },
      { branch: "feature-1", lastActivity: new Date(now.getTime() - 20 * dayInMs) },
      { branch: "feature-2", lastActivity: new Date(now.getTime() - 40 * dayInMs) },
      { branch: "old-branch", lastActivity: new Date(now.getTime() - 100 * dayInMs) },
    ];

    it("should filter branches older than specified age", () => {
      const result = filterBranchesByAge(branches, "30d");
      expect(result).toHaveLength(2);
      expect(result.map((b) => b.branch)).toEqual(["main", "feature-1"]);
    });

    it("should include all branches if max age is very large", () => {
      const result = filterBranchesByAge(branches, "1y");
      expect(result).toHaveLength(4);
    });

    it("should exclude all branches if max age is very small", () => {
      const result = filterBranchesByAge(branches, "1h");
      expect(result).toHaveLength(0);
    });

    it("should return all branches if duration format is invalid", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      const result = filterBranchesByAge(branches, "invalid");
      expect(result).toHaveLength(4);
      expect(consoleSpy).toHaveBeenCalledWith("Invalid duration format: invalid. Using all branches.");
      consoleSpy.mockRestore();
    });

    it("should handle edge case of exact cutoff", () => {
      // Use a fixed date to avoid timing issues
      const fixedNow = new Date("2024-01-15T12:00:00Z");
      const exactCutoffDate = new Date(fixedNow.getTime() - 30 * dayInMs);
      const exactCutoffBranches = [{ branch: "exact", lastActivity: exactCutoffDate }];

      // Mock Date.now() to return our fixed date
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => fixedNow.getTime());

      const result = filterBranchesByAge(exactCutoffBranches, "30d");

      // Restore Date.now()
      Date.now = originalDateNow;

      expect(result).toHaveLength(1);
    });
  });

  describe("formatDuration", () => {
    it("should format singular units correctly", () => {
      expect(formatDuration("1h")).toBe("1 hour");
      expect(formatDuration("1d")).toBe("1 day");
      expect(formatDuration("1w")).toBe("1 week");
      expect(formatDuration("1m")).toBe("1 month");
      expect(formatDuration("1y")).toBe("1 year");
    });

    it("should format plural units correctly", () => {
      expect(formatDuration("24h")).toBe("24 hours");
      expect(formatDuration("30d")).toBe("30 days");
      expect(formatDuration("4w")).toBe("4 weeks");
      expect(formatDuration("6m")).toBe("6 months");
      expect(formatDuration("2y")).toBe("2 years");
    });

    it("should return original string for invalid formats", () => {
      expect(formatDuration("invalid")).toBe("invalid");
      expect(formatDuration("30")).toBe("30");
      expect(formatDuration("")).toBe("");
    });
  });
});
