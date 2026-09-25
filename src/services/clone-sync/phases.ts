import type { PhaseTimer } from "../../utils/timing";

// The phases a sync tick is broken into for `--debug`'s timing table, in the
// order they run. The names follow worktree mode's ('Phase N: X', in
// WorktreeModeSyncRunner) so that output is one format to learn rather than
// two, and the numbers are fixed labels rather than positions in the printed
// table: a phase this tick never reached leaves a visible gap instead of
// renumbering the rows under it.
//
// A phase has a row if and only if it ran. Since a tick classifies before it
// reads the working tree, most ticks end at Classify and print no Status row at
// all, and Sparse only appears where `sparseCheckout` is configured — the same
// way worktree mode prints no 'Phase 4: Update' row when updates are off. The
// alternative, a zero-duration row for work that never happened, would read as
// a scan that cost nothing rather than a scan that was skipped.
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

// Brackets one phase of the tick. The phase is closed in a `finally`, so an
// early return or a throw inside `run` still closes it — an open phase would
// keep running until the table is rendered and silently swallow the rest of
// the tick, which is the one way timing here could lie. With no timer this is
// a plain call: nothing is allocated and nothing new can throw.
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
