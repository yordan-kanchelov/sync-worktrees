import type { PhaseTimer } from "../../utils/timing";

export const CLONE_SYNC_PHASES = {
  VALIDATE: "Phase 1: Validate",
  UNSHALLOW: "Phase 2: Unshallow",
  REMOTE_CONFIG: "Phase 3: Remote config",
  FETCH: "Phase 4: Fetch",
  VERIFY_REF: "Phase 5: Verify ref",
  SPARSE: "Phase 6: Sparse",
  CLASSIFY: "Phase 7: Classify",
  STATUS: "Phase 8: Status",
  MERGE: "Phase 9: Merge",
} as const;

export async function timePhase<T>(
  phaseTimer: PhaseTimer | undefined,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!phaseTimer) return run();
  phaseTimer.startPhase(name);
  try {
    return await run();
  } finally {
    phaseTimer.endPhase();
  }
}
