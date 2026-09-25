import { Logger } from "../services/logger.service";

export function parseDuration(durationStr: string): number | null {
  const match = durationStr.match(/^(\d+)([hdwmy])$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    h: 60 * 60 * 1000, // hours
    d: 24 * 60 * 60 * 1000, // days
    w: 7 * 24 * 60 * 60 * 1000, // weeks
    m: 30 * 24 * 60 * 60 * 1000, // months (approximate)
    y: 365 * 24 * 60 * 60 * 1000, // years (approximate)
  };

  return value * multipliers[unit];
}

// The warning goes through the caller's logger: under the TUI a bare
// console.warn would be written straight over the Ink frame.
export function filterBranchesByAge(
  branches: { branch: string; lastActivity: Date }[],
  maxAge: string,
  logger: Pick<Logger, "warn"> = Logger.createDefault(),
): { branch: string; lastActivity: Date }[] {
  const maxAgeMs = parseDuration(maxAge);
  if (maxAgeMs === null) {
    logger.warn(`Invalid duration format: ${maxAge}. Using all branches.`);
    return branches;
  }

  const cutoffDate = new Date(Date.now() - maxAgeMs);

  return branches.filter(({ lastActivity }) => lastActivity >= cutoffDate);
}

export function formatDuration(durationStr: string): string {
  const match = durationStr.match(/^(\d+)([hdwmy])$/);
  if (!match) {
    return durationStr;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const unitNames: Record<string, string> = {
    h: value === 1 ? "hour" : "hours",
    d: value === 1 ? "day" : "days",
    w: value === 1 ? "week" : "weeks",
    m: value === 1 ? "month" : "months",
    y: value === 1 ? "year" : "years",
  };

  return `${value} ${unitNames[unit]}`;
}
