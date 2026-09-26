import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import pLimit from "p-limit";
import { isMouseSequence } from "../utils/mouse";
import { getErrorMessage } from "../utils/errors";
import { fuzzyFilter } from "../utils/fuzzy";
import type { FuzzyResult } from "../utils/fuzzy";
import type { RepositoryListEntry } from "../types";
import { isListDown, isListUp, listRowsFor, listWindow, useModalLayout, wrappedRows } from "./layout";

export interface SwitcherEntry {
  repoIndex: number;
  repoName: string;
  branch: string;
  path: string;
  /** `repo › branch`: what is shown, and what the query is matched against. */
  label: string;
}

type LaunchResult = { success: boolean; error?: string };

export interface FuzzySwitcherProps {
  repositories: RepositoryListEntry[];
  getWorktreesForRepo: (index: number) => Promise<Array<{ path: string; branch: string }>>;
  openEditorInWorktree: (worktreePath: string) => LaunchResult;
  openTerminalInWorktree: (repoIndex: number, worktreePath: string, branchName: string) => LaunchResult;
  /** Absent: the copy action is not offered. */
  copyToClipboard?: (text: string) => Promise<LaunchResult>;
  /** Start a sync of one repository. Returns why it could not start, or null once it has. Absent: not offered. */
  syncRepository?: (repoIndex: number) => string | null;
  /** Hand over to the status view for this worktree. Absent: not offered. */
  showStatus?: (repoIndex: number, branch: string) => void;
  /** A one-line confirmation the App shows after the switcher has closed. */
  notify?: (message: string) => void;
  onClose: () => void;
  /** Rows the switcher may use; defaults to the terminal height. */
  availableRows?: number;
}

type Mode = "LIST" | "ACTIONS";
type Message = { text: string; level: "error" | "warn" | "info" };
type ActionKey = "editor" | "terminal" | "copy" | "sync" | "status";

interface ActionRow {
  action: ActionKey;
  keys: string;
  description: string;
}

// `git worktree list` per repository, a few at a time: a config with dozens of
// repositories should not open dozens of git processes the moment `/` is hit.
const LOAD_CONCURRENCY = 4;

const entryKey = (entry: SwitcherEntry): string => `${entry.repoIndex}\u0000${entry.path}`;

/** The label split into runs of matched and unmatched characters, for highlighting. */
function labelRuns(label: string, positions: readonly number[]): Array<{ text: string; matched: boolean }> {
  if (positions.length === 0) return [{ text: label, matched: false }];
  const matched = new Set(positions);
  const runs: Array<{ text: string; matched: boolean }> = [];
  for (let i = 0; i < label.length; i++) {
    const isMatch = matched.has(i);
    const last = runs[runs.length - 1];
    if (last && last.matched === isMatch) last.text += label[i];
    else runs.push({ text: label[i], matched: isMatch });
  }
  return runs;
}

const FuzzySwitcher: React.FC<FuzzySwitcherProps> = ({
  repositories,
  getWorktreesForRepo,
  openEditorInWorktree,
  openTerminalInWorktree,
  copyToClipboard,
  syncRepository,
  showStatus,
  notify,
  onClose,
  availableRows,
}) => {
  const layout = useModalLayout(80, availableRows);
  const [mode, setMode] = useState<Mode>("LIST");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Per repository, in the order the repositories are listed, so a slow one
  // arriving last does not reorder what is already on screen.
  const [loaded, setLoaded] = useState<Record<number, SwitcherEntry[]>>({});
  const [failed, setFailed] = useState<Array<{ repoName: string; error: string }>>([]);
  const [settledCount, setSettledCount] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One load per opening, of the repository list as it was when the switcher
  // opened: a reload while it is open must not relabel what it already shows.
  // Worktrees are read afresh each time the switcher opens rather than cached,
  // so one a sync just added or removed is shown as it is now.
  const repositoriesRef = useRef(repositories);
  const getWorktreesRef = useRef(getWorktreesForRepo);
  useEffect(() => {
    const limit = pLimit(LOAD_CONCURRENCY);
    for (const repo of repositoriesRef.current) {
      void limit(async () => {
        try {
          const worktrees = await getWorktreesRef.current(repo.index);
          if (!mountedRef.current) return;
          const entries = worktrees.map((wt) => ({
            repoIndex: repo.index,
            repoName: repo.name,
            branch: wt.branch,
            path: wt.path,
            label: `${repo.name} › ${wt.branch}`,
          }));
          setLoaded((prev) => ({ ...prev, [repo.index]: entries }));
        } catch (error) {
          if (!mountedRef.current) return;
          setFailed((prev) => [...prev, { repoName: repo.name, error: getErrorMessage(error) }]);
        } finally {
          if (mountedRef.current) setSettledCount((prev) => prev + 1);
        }
      });
    }
  }, []);

  const snapshot = repositoriesRef.current;
  const entries = useMemo(() => snapshot.flatMap((repo) => loaded[repo.index] ?? []), [snapshot, loaded]);
  const loading = settledCount < snapshot.length;

  const results: FuzzyResult<SwitcherEntry>[] = useMemo(
    () => fuzzyFilter(entries, query, (entry) => entry.label),
    [entries, query],
  );

  // The selection follows the entry, not the row: repositories still loading
  // insert rows above it, and a moving index would silently swap what Enter opens.
  const foundIndex = selectedKey === null ? -1 : results.findIndex((r) => entryKey(r.item) === selectedKey);
  const selectedIndex = Math.max(0, foundIndex);
  const selected = results[selectedIndex]?.item ?? null;

  const actions = useMemo((): ActionRow[] => {
    const rows: ActionRow[] = [
      { action: "editor", keys: "e / Enter", description: "Open in editor" },
      { action: "terminal", keys: "t", description: "Open terminal (tmux)" },
    ];
    if (copyToClipboard) rows.push({ action: "copy", keys: "y", description: "Copy path to clipboard" });
    if (syncRepository) rows.push({ action: "sync", keys: "s", description: "Sync this repository" });
    if (showStatus) rows.push({ action: "status", keys: "w", description: "Show status" });
    return rows;
  }, [copyToClipboard, syncRepository, showStatus]);

  const runAction = (action: ActionKey, entry: SwitcherEntry): void => {
    setMessage(null);
    switch (action) {
      case "editor":
      case "terminal": {
        const result =
          action === "editor"
            ? openEditorInWorktree(entry.path)
            : openTerminalInWorktree(entry.repoIndex, entry.path, entry.branch);
        if (result.success) {
          onClose();
        } else {
          setMessage({
            text: result.error || (action === "editor" ? "Failed to open editor" : "Failed to open terminal"),
            level: "error",
          });
        }
        return;
      }
      case "copy": {
        if (!copyToClipboard) return;
        setBusy(true);
        void copyToClipboard(entry.path)
          .catch((error: unknown) => ({ success: false, error: getErrorMessage(error) }))
          .then((result) => {
            if (!mountedRef.current) return;
            setBusy(false);
            if (result.success) {
              notify?.(`Copied ${entry.path}`);
              onClose();
            } else {
              // The path stays on screen with the reason, so it can still be
              // selected by hand (Shift+drag) when there is no clipboard tool.
              setMessage({ text: `${result.error ?? "Copy failed"} — path: ${entry.path}`, level: "error" });
            }
          });
        return;
      }
      case "sync": {
        if (!syncRepository) return;
        const refusal = syncRepository(entry.repoIndex);
        if (refusal === null) {
          notify?.(`Syncing ${entry.repoName}…`);
          onClose();
        } else {
          setMessage({ text: refusal, level: "warn" });
        }
        return;
      }
      case "status":
        showStatus?.(entry.repoIndex, entry.branch);
        return;
    }
  };

  const moveSelection = (delta: number): void => {
    if (results.length === 0) return;
    const next = Math.min(results.length - 1, Math.max(0, selectedIndex + delta));
    setSelectedKey(entryKey(results[next].item));
  };

  const editQuery = (next: string): void => {
    setQuery(next);
    // Back to the best match: a query that changed has re-ranked everything.
    setSelectedKey(null);
    setMessage(null);
  };

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (busy) return;

    if (mode === "ACTIONS") {
      if (key.escape || key.tab) {
        setMode("LIST");
        setMessage(null);
        return;
      }
      if (!selected) return;
      if (key.return || input === "e") runAction("editor", selected);
      else if (input === "t") runAction("terminal", selected);
      else if (input === "y" && copyToClipboard) runAction("copy", selected);
      else if (input === "s" && syncRepository) runAction("sync", selected);
      else if (input === "w" && showStatus) runAction("status", selected);
      return;
    }

    if (key.escape) {
      onClose();
    } else if (isListUp(input, key)) {
      moveSelection(-1);
    } else if (isListDown(input, key)) {
      moveSelection(1);
    } else if (key.return) {
      if (selected) runAction("editor", selected);
    } else if (key.tab) {
      if (selected) {
        // Pinned by key: a repository that finishes loading while the menu is
        // open must not re-rank a different entry under the actions.
        setSelectedKey(entryKey(selected));
        setMessage(null);
        setMode("ACTIONS");
      }
    } else if (key.ctrl && input === "u") {
      editQuery("");
    } else if (key.backspace || key.delete) {
      editQuery(query.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      editQuery(query + input);
    }
  });

  usePaste((text) => {
    if (mode === "LIST" && !busy) editQuery(query + text.replace(/[\r\n]+/g, " "));
  });

  const footer =
    mode === "ACTIONS"
      ? "Press a key above • Tab/ESC back to the list"
      : "↑/↓ ^N/^P move • Enter editor • Tab actions • Ctrl-U clear • ESC close";
  const footerExtra = wrappedRows(footer, layout.innerWidth) - 1;
  const room = layout.rows - layout.chromeRows - footerExtra;

  const messageLine = message && (
    <Text
      color={message.level === "error" ? "red" : message.level === "warn" ? "yellow" : undefined}
      wrap="truncate-end"
    >
      {message.text}
    </Text>
  );

  const renderList = () => {
    const status = loading ? ` loading ${settledCount}/${snapshot.length} repositories…` : "";
    const failureLine =
      failed.length > 0 ? `Could not list ${failed.map((f) => f.repoName).join(", ")}: ${failed[0].error}` : null;
    // The query line and the gap under it, the gap above the path line and the
    // path line itself, and whichever of the message and failure lines show.
    const linesAround = 4 + (message ? 1 : 0) + (failureLine ? 1 : 0);
    const visibleCount = listRowsFor(room - linesAround, results.length);
    const { start, end } = listWindow(selectedIndex, results.length, visibleCount);

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>
            {"> "}
          </Text>
          <Text>{query}</Text>
          <Text inverse> </Text>
          <Text dimColor wrap="truncate-end">
            {"  "}
            {results.length}/{entries.length}
            {status}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {results.length === 0 ? (
            <Text color="yellow">
              {loading ? "Loading worktrees…" : entries.length === 0 ? "No worktrees found" : "No matches"}
            </Text>
          ) : (
            <>
              {start > 0 && <Text dimColor> ↑ {start} more</Text>}
              {results.slice(start, end).map((result, offset) => {
                const isSelected = start + offset === selectedIndex;
                return (
                  <Text key={entryKey(result.item)} wrap="truncate-end" color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "> " : "  "}
                    {labelRuns(result.item.label, result.match.positions).map((run, runIndex) =>
                      run.matched ? (
                        <Text key={runIndex} bold color="yellow">
                          {run.text}
                        </Text>
                      ) : (
                        <Text key={runIndex}>{run.text}</Text>
                      ),
                    )}
                  </Text>
                );
              })}
              {end < results.length && <Text dimColor> ↓ {results.length - end} more</Text>}
            </>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {selected ? selected.path : " "}
          </Text>
        </Box>
        {messageLine}
        {failureLine && (
          <Text color="yellow" dimColor wrap="truncate-end">
            {failureLine}
          </Text>
        )}
      </Box>
    );
  };

  const renderActions = () => {
    if (!selected) return null;
    // One row per action when the terminal has them; otherwise all of them on
    // one line, so the menu never pushes the status bar off the screen.
    const roomy = room >= actions.length + 3 + (message ? 1 : 0);
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {selected.label}
        </Text>
        <Text dimColor wrap="truncate-end">
          {selected.path}
        </Text>
        {roomy ? (
          <Box flexDirection="column" marginTop={1}>
            {actions.map((row) => (
              <Box key={row.action}>
                <Box width={12} flexShrink={0}>
                  <Text bold color="yellow">
                    {row.keys}
                  </Text>
                </Box>
                <Text wrap="truncate-end">{row.description}</Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Text wrap="truncate-end">
            {actions.map((row) => `${row.keys.split(" ")[0]} ${row.description.toLowerCase()}`).join(" · ")}
          </Text>
        )}
        {busy && <Text color="yellow">Copying…</Text>}
        {messageLine}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" marginTop={layout.marginY} marginBottom={layout.marginY}>
      <Box
        borderStyle="round"
        borderColor="magenta"
        paddingX={2}
        paddingY={layout.paddingY}
        flexDirection="column"
        width={layout.width}
      >
        <Box marginBottom={1}>
          <Text bold color="magenta" wrap="truncate-end">
            🔎 Go to worktree{mode === "ACTIONS" ? " › actions" : ""}
          </Text>
        </Box>

        {mode === "LIST" ? renderList() : renderActions()}

        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      </Box>
    </Box>
  );
};

export default FuzzySwitcher;
