import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { isMouseSequence } from "../utils/mouse";

import { formatBytes } from "../utils/disk-space";

import type { ForceCleanRepositoryPreview, ForceCleanRepositoryResult } from "../types";

export interface ForceCleanModalProps {
  getPreview: () => Promise<ForceCleanRepositoryPreview[]>;
  forceClean: (repoIndexes: number[]) => Promise<ForceCleanRepositoryResult[]>;
  onClose: () => void;
}

const ForceCleanModal: React.FC<ForceCleanModalProps> = ({ getPreview, forceClean, onClose }) => {
  const [previews, setPreviews] = useState<ForceCleanRepositoryPreview[]>([]);
  const [results, setResults] = useState<ForceCleanRepositoryResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useInput((input, key) => {
    // Mouse reports arrive as a single `input` string; ignore them here so a
    // scroll never registers as a keystroke.
    if (isMouseSequence(input)) return;

    if (cleaning) return;
    if (results !== null) {
      if (key.escape || key.return || input === "q") onClose();
      return;
    }
    if (input === "n" || input === "N" || key.escape) {
      onClose();
    } else if ((input === "y" || input === "Y") && !loading && !error) {
      setCleaning(true);
      // Only the repos whose counts are on screen — a repo whose preview failed
      // was never shown a number, so it must not be purged on this confirmation.
      forceClean(previews.filter((row) => row.preview).map((row) => row.repoIndex))
        .then(setResults)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setCleaning(false));
    }
  });

  return (
    <Box justifyContent="center" alignItems="center" flexDirection="column" marginTop={1} marginBottom={1}>
      <Box borderStyle="double" borderColor="red" paddingX={2} paddingY={1} flexDirection="column" width={78}>
        <Text bold color="red">
          Force Clean
        </Text>
        <Text>This permanently purges verified trash and recovery refs, then runs git gc --prune=now.</Text>
        <Text>Active worktrees are not synced, changed, or removed.</Text>

        <Box flexDirection="column" marginTop={1}>
          {loading && <Text color="yellow">Loading cleanup preview...</Text>}
          {!loading &&
            previews.map((row) =>
              row.preview ? (
                <Text key={row.repoIndex}>
                  {row.repoName}: {row.preview.trashEntries} trash ({formatBytes(row.preview.trashBytes)}),{" "}
                  {row.preview.keepRefs} recovery refs
                  {row.preview.unknownTrashSizes > 0 ? `, ${row.preview.unknownTrashSizes} unknown sizes` : ""}
                  {row.preview.invalidTrashEntries > 0 ? `, ${row.preview.invalidTrashEntries} skipped invalid` : ""}
                </Text>
              ) : (
                <Text key={row.repoIndex} color="red">
                  {row.repoName}: unavailable — {row.error}
                </Text>
              ),
            )}
          {!loading && results === null && (
            <Text bold>
              Total: {totals.trashEntries} trash ({formatBytes(totals.trashBytes)}), {totals.keepRefs} recovery refs
            </Text>
          )}
          {totals.invalid > 0 && results === null && (
            <Text color="yellow">{totals.invalid} invalid/unrecognized trash entries will be left untouched.</Text>
          )}
          {cleaning && <Text color="yellow">Cleaning repositories...</Text>}
          {results?.map((row) =>
            row.result ? (
              <Text key={row.repoIndex} color={row.result.errors.length > 0 ? "yellow" : "green"}>
                {row.repoName}: deleted {row.result.trashDeleted} trash and {row.result.keepRefsDeleted} refs; GC{" "}
                {row.result.gcSucceeded ? "complete" : "failed"}
                {row.result.keepRefsRetained > 0
                  ? `; kept ${row.result.keepRefsRetained} ref(s) still backing a .diverged copy`
                  : ""}
                {row.result.errors.length > 0 ? ` (${row.result.errors.join("; ")})` : ""}
              </Text>
            ) : (
              <Text key={row.repoIndex} color="red">
                {row.repoName}: failed — {row.error}
              </Text>
            ),
          )}
          {error && <Text color="red">{error}</Text>}
        </Box>

        <Box justifyContent="center" marginTop={1}>
          <Text dimColor>
            {results !== null
              ? "Press Enter / Esc / q to close"
              : cleaning
                ? "Cleanup is running"
                : loading
                  ? "Press Esc to cancel"
                  : "Delete permanently? y / n"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default ForceCleanModal;
