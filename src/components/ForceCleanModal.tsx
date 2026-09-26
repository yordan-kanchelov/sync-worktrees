import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { isMouseSequence } from "../utils/mouse";
import { isListDown, isListUp, useModalLayout, wrappedRows } from "./layout";

import { formatBytes } from "../utils/disk-space";

import type {
  ForceCleanPreview,
  ForceCleanRepositoryPreview,
  ForceCleanRepositoryResult,
  ForceCleanRepositorySelection,
} from "../types";

export interface ForceCleanModalProps {
  getPreview: () => Promise<ForceCleanRepositoryPreview[]>;
  forceClean: (selections: ForceCleanRepositorySelection[]) => Promise<ForceCleanRepositoryResult[]>;
  onClose: () => void;
  /** Rows the modal may use; defaults to the terminal height. */
  availableRows?: number;
}

// What has to be typed before the purge runs. A single `y` sat right next to
// `n` and fired on a key repeat; a word is a decision.
export const FORCE_CLEAN_CONFIRM_WORD = "clean";

const EXPLANATION = [
  "This permanently purges verified trash and recovery refs, then runs git gc on the object store every worktree shares.",
  "Active worktree files are not synced, changed, or removed — but that shared object store is, so finish any git " +
    "command running in a worktree first. If any worktree is caught mid-operation the gc is skipped for that whole " +
    "repository; the purge still runs. A lock left behind by a crashed command keeps reporting busy until it is removed.",
];
// What a short terminal gets instead: the part that asks something of the reader.
const SHORT_EXPLANATION = [
  "Permanently purges verified trash and recovery refs, then runs git gc on the shared object store; finish any git command running in a worktree first.",
];
/** The per-repository list keeps at least this many rows before the explanation is shortened. */
const MIN_LIST_ROWS_BEFORE_SHORTENING = 3;

type Color = "red" | "yellow" | "green";

interface Line {
  key: string;
  text: string;
  color?: Color;
  bold?: boolean;
}

/** Rows a message takes: every line of it, each word-wrapped to `width`. */
const textRows = (text: string, width: number): number =>
  text.split("\n").reduce((sum, line) => sum + wrappedRows(line, width), 0);

function previewLine(row: ForceCleanRepositoryPreview): Line {
  if (!row.preview) {
    return { key: `repo-${row.repoIndex}`, text: `${row.repoName}: unavailable — ${row.error}`, color: "red" };
  }
  const p = row.preview;
  return {
    key: `repo-${row.repoIndex}`,
    text:
      `${row.repoName}: ${p.trashEntries} trash (${formatBytes(p.trashBytes)}), ${p.keepRefs} recovery refs` +
      (p.unknownTrashSizes > 0 ? `, ${p.unknownTrashSizes} unknown sizes` : "") +
      (p.invalidTrashEntries > 0 ? `, ${p.invalidTrashEntries} skipped invalid` : ""),
  };
}

function resultLine(row: ForceCleanRepositoryResult): Line {
  if (!row.result) {
    return { key: `repo-${row.repoIndex}`, text: `${row.repoName}: failed — ${row.error}`, color: "red" };
  }
  const r = row.result;
  return {
    key: `repo-${row.repoIndex}`,
    color: r.errors.length > 0 || r.skippedNewEntries > 0 || r.skippedNewKeepRefs > 0 ? "yellow" : "green",
    text:
      `${row.repoName}: deleted ${r.trashDeleted} trash and ${r.keepRefsDeleted} refs; GC ` +
      (r.gcSkipped ? "skipped" : r.gcSucceeded ? "complete" : "failed") +
      (r.keepRefsRetained > 0 ? `; kept ${r.keepRefsRetained} ref(s) still backing a .diverged copy` : "") +
      (r.skippedNewEntries > 0 || r.skippedNewKeepRefs > 0
        ? `; left ${r.skippedNewEntries} trash and ${r.skippedNewKeepRefs} ref(s) added after this preview`
        : "") +
      (r.errors.length > 0 ? ` (${r.errors.join("; ")})` : ""),
  };
}

const ForceCleanModal: React.FC<ForceCleanModalProps> = ({ getPreview, forceClean, onClose, availableRows }) => {
  const layout = useModalLayout(78, availableRows);
  const { width } = layout;
  const [scrollOffset, setScrollOffset] = useState(0);
  const [previews, setPreviews] = useState<ForceCleanRepositoryPreview[]>([]);
  const [results, setResults] = useState<ForceCleanRepositoryResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let cancelled = false;
    getPreview()
      .then((next) => {
        if (!cancelled) setPreviews(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getPreview]);

  const totals = useMemo(
    () =>
      previews.reduce(
        (sum, row) => ({
          trashEntries: sum.trashEntries + (row.preview?.trashEntries ?? 0),
          trashBytes: sum.trashBytes + (row.preview?.trashBytes ?? 0),
          keepRefs: sum.keepRefs + (row.preview?.keepRefs ?? 0),
          invalid: sum.invalid + (row.preview?.invalidTrashEntries ?? 0),
        }),
        { trashEntries: 0, trashBytes: 0, keepRefs: 0, invalid: 0 },
      ),
    [previews],
  );

  const nothingToClean = totals.trashEntries === 0 && totals.keepRefs === 0;
  const awaitingConfirmation = results === null && !cleaning && !loading && !error && !nothingToClean;

  // The per-repository rows: the preview, then what the purge did.
  const items: Line[] = results !== null ? results.map(resultLine) : loading ? [] : previews.map(previewLine);
  // Everything else under them, which is never scrolled away.
  const statusLines: Line[] = [
    ...(loading ? [{ key: "loading", text: "Loading cleanup preview...", color: "yellow" as const }] : []),
    ...(!loading && results === null && !error && nothingToClean
      ? [{ key: "nothing", text: "Nothing to clean.", color: "green" as const }]
      : []),
    ...(!loading && results === null && !nothingToClean
      ? [
          {
            key: "total",
            text: `Total: ${totals.trashEntries} trash (${formatBytes(totals.trashBytes)}), ${totals.keepRefs} recovery refs`,
            bold: true,
          },
        ]
      : []),
    ...(totals.invalid > 0 && results === null
      ? [
          {
            key: "invalid",
            text: `${totals.invalid} invalid/unrecognized trash entries will be left untouched.`,
            color: "yellow" as const,
          },
        ]
      : []),
    ...(cleaning ? [{ key: "cleaning", text: "Cleaning repositories...", color: "yellow" as const }] : []),
    ...(error ? [{ key: "error", text: error, color: "red" as const }] : []),
  ];
  const footerText = cleaning
    ? "Cleanup is running"
    : loading
      ? "Press Esc to cancel"
      : "Press Enter / Esc / q to close";
  const footerRows = awaitingConfirmation
    ? wrappedRows(
        `Type ${FORCE_CLEAN_CONFIRM_WORD} and press Enter to delete permanently: ${typed || "_"} (Esc to cancel)`,
        layout.innerWidth,
      )
    : wrappedRows(footerText, layout.innerWidth);

  // Rows the per-repository list has once everything else is drawn. The
  // explanation gives way to its short form before the list is squeezed below
  // a few rows, and a list that still does not fit scrolls one line per
  // repository, so the frame never pushes the status bar off the screen.
  const itemRows = items.reduce((sum, line) => sum + textRows(line.text, layout.innerWidth), 0);
  const fixedRows =
    layout.chromeRows +
    (footerRows - 1) +
    statusLines.reduce((sum, line) => sum + textRows(line.text, layout.innerWidth), 0);
  const roomWith = (paragraphs: string[]): number =>
    layout.rows - fixedRows - paragraphs.reduce((sum, text) => sum + wrappedRows(text, layout.innerWidth), 0);
  const explanation =
    roomWith(EXPLANATION) >= Math.min(itemRows, MIN_LIST_ROWS_BEFORE_SHORTENING) ? EXPLANATION : SHORT_EXPLANATION;
  const listRoom = roomWith(explanation);
  const listScrolls = itemRows > Math.max(0, listRoom);
  // One row for the `repositories 3–5 of 12` line, reserved while it scrolls.
  const visibleCount = listScrolls ? Math.max(1, listRoom - 1) : items.length;
  const maxOffset = Math.max(0, items.length - visibleCount);
  const offset = Math.min(scrollOffset, maxOffset);
  const visibleItems = items.slice(offset, offset + visibleCount);

  useInput((input, key) => {
    // Mouse reports arrive as a single `input` string; ignore them here so a
    // scroll never registers as a keystroke.
    if (isMouseSequence(input)) return;

    // Arrows and Ctrl-P/N only: j and k are letters the confirmation word
    // could be typed with.
    if (listScrolls && isListUp(input, key)) {
      setScrollOffset((prev) => Math.max(0, Math.min(prev, maxOffset) - 1));
      return;
    }
    if (listScrolls && isListDown(input, key)) {
      setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      return;
    }

    if (cleaning) return;
    if (results !== null || (!loading && !awaitingConfirmation)) {
      if (key.escape || key.return || input === "q") onClose();
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (!awaitingConfirmation) return;
    if (key.backspace || key.delete) {
      setTyped((prev) => prev.slice(0, -1));
    } else if (key.return) {
      if (typed.trim().toLowerCase() !== FORCE_CLEAN_CONFIRM_WORD) return;
      setCleaning(true);
      // Only the repos whose counts are on screen — a repo whose preview failed
      // was never shown a number, so it must not be purged on this
      // confirmation — and inside each of those, only the entries and refs
      // those counts were computed from. A sync can trash more while this modal
      // waits for a keypress; the extra entries are not part of what was shown.
      forceClean(
        previews
          .filter(
            (row): row is ForceCleanRepositoryPreview & { preview: ForceCleanPreview } => row.preview !== undefined,
          )
          .map((row) => ({
            repoIndex: row.repoIndex,
            trashEntryIds: row.preview.trashEntryIds,
            keepRefNames: row.preview.keepRefNames,
          })),
      )
        .then(setResults)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setCleaning(false));
    } else if (input && !key.ctrl && !key.meta) {
      setTyped((prev) => (prev + input).slice(0, 32));
    }
  });

  return (
    <Box
      justifyContent="center"
      alignItems="center"
      flexDirection="column"
      marginTop={layout.marginY}
      marginBottom={layout.marginY}
    >
      <Box
        borderStyle="double"
        borderColor="red"
        paddingX={2}
        paddingY={layout.paddingY}
        flexDirection="column"
        width={width}
      >
        <Text bold color="red">
          Force Clean
        </Text>
        {explanation.map((paragraph) => (
          <Text key={paragraph}>{paragraph}</Text>
        ))}

        <Box flexDirection="column" marginTop={1}>
          {visibleItems.map((line) => (
            <Text key={line.key} color={line.color} wrap={listScrolls ? "truncate-end" : "wrap"}>
              {line.text}
            </Text>
          ))}
          {listScrolls && (
            <Text dimColor wrap="truncate-end">
              {`repositories ${offset + 1}–${offset + visibleItems.length} of ${items.length} (↑/↓ to scroll)`}
            </Text>
          )}
          {statusLines.map((line) => (
            <Text key={line.key} color={line.color} bold={line.bold}>
              {line.text}
            </Text>
          ))}
        </Box>

        <Box justifyContent="center" marginTop={1}>
          {awaitingConfirmation ? (
            <Text>
              Type <Text bold>{FORCE_CLEAN_CONFIRM_WORD}</Text> and press Enter to delete permanently:{" "}
              <Text color="red">{typed || "_"}</Text> <Text dimColor>(Esc to cancel)</Text>
            </Text>
          ) : (
            <Text dimColor>{footerText}</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default ForceCleanModal;
