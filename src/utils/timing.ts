import Table from "cli-table3";

export interface TimingResult {
  name: string;
  duration: number;
  count?: number;
  efficiency?: number;
}

export class Timer {
  private startTime: number;
  private endTime?: number;

  constructor() {
    this.startTime = Date.now();
  }

  stop(): number {
    this.endTime = Date.now();
    return this.getDuration();
  }

  getDuration(): number {
    const end = this.endTime ?? Date.now();
    return end - this.startTime;
  }
}

export class PhaseTimer {
  private phases: Map<string, { timer: Timer; count?: number; parallelism?: number }> = new Map();
  private currentPhase?: string;

  startPhase(name: string, parallelism?: number): void {
    if (this.currentPhase) {
      this.endPhase();
    }
    this.currentPhase = name;
    this.phases.set(name, { timer: new Timer(), parallelism });
  }

  endPhase(): void {
    if (this.currentPhase) {
      const phase = this.phases.get(this.currentPhase);
      if (phase) {
        phase.timer.stop();
      }
      this.currentPhase = undefined;
    }
  }

  setPhaseCount(name: string, count: number): void {
    const phase = this.phases.get(name);
    if (phase) {
      phase.count = count;
    }
  }

  getResults(): TimingResult[] {
    if (this.currentPhase) {
      this.endPhase();
    }

    const results: TimingResult[] = [];

    for (const [name, { timer, count, parallelism }] of this.phases.entries()) {
      const duration = timer.getDuration();
      const result: TimingResult = {
        name,
        duration,
        count,
      };

      if (count && count > 0 && parallelism && parallelism > 1) {
        const batches = Math.ceil(count / parallelism);
        const avgTimePerBatch = duration / batches;
        const theoreticalSequentialTime = count * avgTimePerBatch;
        result.efficiency =
          theoreticalSequentialTime > 0 ? Math.round((theoreticalSequentialTime / duration) * 100) : 100;
      }

      results.push(result);
    }

    return results;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatTimingTable(totalDuration: number, phaseResults: TimingResult[], repoName?: string): string {
  const header = repoName ? `Performance Summary - [${repoName}]` : "Performance Summary";

  const table = new Table({
    head: ["Operation", "Duration", "Efficiency"],
    colWidths: [35, 12, 12],
    style: {
      head: ["cyan", "bold"],
      border: ["gray"],
    },
  });

  table.push([{ colSpan: 3, content: header, hAlign: "center" }]);

  table.push(["Total Sync", formatDuration(totalDuration), ""]);

  for (let i = 0; i < phaseResults.length; i++) {
    const result = phaseResults[i];
    const isLast = i === phaseResults.length - 1;
    const countStr = result.count ? ` (${result.count})` : "";
    const prefix = isLast ? "└─" : "├─";
    const name = `  ${prefix} ${result.name}${countStr}`;
    const efficiency = result.efficiency ? `${result.efficiency}%` : "";

    table.push([name, formatDuration(result.duration), efficiency]);
  }

  return table.toString();
}
