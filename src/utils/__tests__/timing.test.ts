import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhaseTimer, Timer, formatDuration, formatTimingTable } from "../timing";

describe("Timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should measure duration correctly", () => {
    const timer = new Timer();

    vi.advanceTimersByTime(1000);

    expect(timer.getDuration()).toBe(1000);
  });

  it("should stop and return duration", () => {
    const timer = new Timer();

    vi.advanceTimersByTime(500);

    const duration = timer.stop();
    expect(duration).toBe(500);

    vi.advanceTimersByTime(500);

    expect(timer.getDuration()).toBe(500);
  });
});

describe("PhaseTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should track multiple phases", () => {
    const phaseTimer = new PhaseTimer();

    phaseTimer.startPhase("Phase 1");
    vi.advanceTimersByTime(1000);
    phaseTimer.endPhase();

    phaseTimer.startPhase("Phase 2");
    vi.advanceTimersByTime(2000);
    phaseTimer.endPhase();

    const results = phaseTimer.getResults();

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("Phase 1");
    expect(results[0].duration).toBe(1000);
    expect(results[1].name).toBe("Phase 2");
    expect(results[1].duration).toBe(2000);
  });

  it("should automatically end previous phase when starting new one", () => {
    const phaseTimer = new PhaseTimer();

    phaseTimer.startPhase("Phase 1");
    vi.advanceTimersByTime(1000);

    phaseTimer.startPhase("Phase 2");
    vi.advanceTimersByTime(500);

    const results = phaseTimer.getResults();

    expect(results[0].duration).toBe(1000);
    expect(results[1].duration).toBe(500);
  });

  it("should track operation count", () => {
    const phaseTimer = new PhaseTimer();

    phaseTimer.startPhase("Create");
    vi.advanceTimersByTime(1000);
    phaseTimer.setPhaseCount("Create", 15);
    phaseTimer.endPhase();

    const results = phaseTimer.getResults();

    expect(results[0].count).toBe(15);
  });

  it("should calculate efficiency for parallel operations", () => {
    const phaseTimer = new PhaseTimer();

    phaseTimer.startPhase("Create", 3);
    vi.advanceTimersByTime(3000);
    phaseTimer.setPhaseCount("Create", 9);
    phaseTimer.endPhase();

    const results = phaseTimer.getResults();

    expect(results[0].efficiency).toBe(300);
  });

  it("should not calculate efficiency for sequential operations", () => {
    const phaseTimer = new PhaseTimer();

    phaseTimer.startPhase("Fetch", 1);
    vi.advanceTimersByTime(1000);
    phaseTimer.setPhaseCount("Fetch", 1);
    phaseTimer.endPhase();

    const results = phaseTimer.getResults();

    expect(results[0].efficiency).toBeUndefined();
  });

  it("should handle zero count", () => {
    const phaseTimer = new PhaseTimer();

    phaseTimer.startPhase("Create");
    vi.advanceTimersByTime(1000);
    phaseTimer.setPhaseCount("Create", 0);
    phaseTimer.endPhase();

    const results = phaseTimer.getResults();

    expect(results[0].count).toBe(0);
    expect(results[0].efficiency).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("should format milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("should format seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(5500)).toBe("5.5s");
    expect(formatDuration(59999)).toBe("60.0s");
  });

  it("should format minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(150000)).toBe("2m 30s");
  });
});

describe("formatTimingTable", () => {
  it("should format timing table with all phases", () => {
    const phaseResults = [
      { name: "Phase 1: Fetch", duration: 45000 },
      { name: "Phase 2: Create", duration: 30000, count: 15, efficiency: 100 },
      { name: "Phase 3: Prune", duration: 20000, count: 3, efficiency: 300 },
      { name: "Phase 4: Update", duration: 50000, count: 12, efficiency: 240 },
      { name: "Phase 5: Cleanup", duration: 5000 },
    ];

    const table = formatTimingTable(150000, phaseResults);

    expect(table).toContain("Performance Summary");
    expect(table).toContain("Total Sync");
    expect(table).toContain("2m 30s");
    expect(table).toContain("Phase 1: Fetch");
    expect(table).toContain("45.0s");
    expect(table).toContain("Phase 2: Create (15)");
    expect(table).toContain("100%");
    expect(table).toContain("Phase 3: Prune (3)");
    expect(table).toContain("300%");
  });

  it("should handle phases without count or efficiency", () => {
    const phaseResults = [{ name: "Fetch", duration: 1000 }];

    const table = formatTimingTable(1000, phaseResults);

    expect(table).toContain("Fetch");
    expect(table).toContain("1.0s");
    expect(table).not.toContain("%");
  });

  it("should use box-drawing characters", () => {
    const table = formatTimingTable(1000, []);

    expect(table).toContain("┌");
    expect(table).toContain("└");
    expect(table).toContain("├");
    expect(table).toContain("┤");
    expect(table).toContain("│");
    expect(table).toContain("─");
  });
});
