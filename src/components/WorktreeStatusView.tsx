import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { isMouseSequence } from "../utils/mouse";
import { isListDown, isListUp, listRowsFor, listWindow, useModalLayout, wrappedRows } from "./layout";

import type { WorktreeStatusResult } from "../services/worktree-status.service";
import type { WorktreeStatusEntry, DivergedDirectoryInfo, RepositoryListEntry, RepositoryDiskUsage } from "../types";
import { getErrorMessage } from "../utils/errors";

export type { WorktreeStatusEntry };

type ViewStep = "SELECT_PROJECT" | "VIEW_STATUS" | "ERROR";

export interface WorktreeStatusViewProps {
  repositories: RepositoryListEntry[];
  getWorktreeStatusForRepo: (index: number) => Promise<WorktreeStatusEntry[]>;
  getRepositoryDiskUsage?: (index: number) => Promise<RepositoryDiskUsage>;
  getDivergedDirectoriesForRepo?: (index: number) => Promise<DivergedDirectoryInfo[]>;
  deleteDivergedDirectory?: (repoIndex: number, name: string) => Promise<void>;
  onClose: () => void;
  /** Rows the view may use; defaults to the terminal height. */
  availableRows?: number;
}

type RepositoryDiskUsageState =
  { status: "loading" } | { status: "ready"; usage: RepositoryDiskUsage } | { status: "error" };

type ListItem =
  | { type: "worktree"; entry: WorktreeStatusEntry }
  | { type: "separator" }
  | { type: "diverged"; entry: DivergedDirectoryInfo };

// An expanded entry's detail lines, kept as data so the list can budget the
// rows they take before it decides how many entries fit.
type DetailLine = { text: string; color?: React.ComponentProps<typeof Text>["color"]; dim?: boolean };

// Indent of the detail panel under its row.
const DETAIL_INDENT = 4;

const worktreeDetailLines = (entry: WorktreeStatusEntry): DetailLine[] => {
  const { status } = entry;
  const details = status.details;
  const lines: DetailLine[] = [{ text: `Path: ${entry.path}`, dim: true }];

  if (entry.error !== undefined) lines.push({ text: ` Status probe failed: ${entry.error}`, color: "red" });
  if (details) {
    if (details.modifiedFiles > 0) lines.push({ text: ` Modified: ${details.modifiedFiles}`, color: "yellow" });
    if (details.deletedFiles > 0) lines.push({ text: ` Deleted: ${details.deletedFiles}`, color: "red" });
    if (details.createdFiles > 0) lines.push({ text: ` Created: ${details.createdFiles}`, color: "green" });
    if (details.renamedFiles > 0) lines.push({ text: ` Renamed: ${details.renamedFiles}`, color: "blue" });
    if (details.untrackedFiles > 0) lines.push({ text: ` Untracked: ${details.untrackedFiles}`, color: "gray" });
    if (details.conflictedFiles > 0) lines.push({ text: ` Conflicted: ${details.conflictedFiles}`, color: "red" });
    const unpushed = details.unpushedCommitCount ?? 0;
    if (unpushed > 0) {
      lines.push(
        status.fullyPushedUpstreamDeleted
          ? {
              text: ` Fully pushed before remote branch deletion (${unpushed} commit${unpushed === 1 ? "" : "s"} not on any remote — likely squash-merged)`,
              color: "green",
            }
          : { text: ` Unpushed commits: ${unpushed}`, color: "cyan" },
      );
    }
    if ((details.stashCount ?? 0) > 0) lines.push({ text: ` Stashes: ${details.stashCount}`, color: "magenta" });
    if (details.operationType) lines.push({ text: ` Operation: ${details.operationType}`, color: "red" });
    if (details.modifiedSubmodules && details.modifiedSubmodules.length > 0) {
      lines.push({ text: ` Modified submodules: ${details.modifiedSubmodules.join(", ")}`, color: "yellow" });
    }
  }
  if (status.upstreamGone) lines.push({ text: " Upstream branch no longer exists", color: "red" });
  if (status.reasons.length > 0) lines.push({ text: ` Reasons: ${status.reasons.join(", ")}`, dim: true });
  return lines;
};

const divergedDetailLines = (entry: DivergedDirectoryInfo): DetailLine[] => [
  { text: `Path: ${entry.path}`, dim: true },
  { text: ` Original branch: ${entry.originalBranch}`, dim: true },
  ...(entry.divergedAt ? [{ text: ` Diverged: ${entry.divergedAt}`, dim: true }] : []),
  { text: ` Size: ${entry.sizeFormatted}`, dim: true },
];

const getStatusFlags = (status: WorktreeStatusResult): React.ReactNode => {
  const flags: React.ReactNode[] = [];

  if (
    status.isClean &&
    !status.hasUnpushedCommits &&
    !status.hasStashedChanges &&
    !status.hasOperationInProgress &&
    !status.hasModifiedSubmodules &&
    !status.upstreamGone
  ) {
    return <Text color="green">✓</Text>;
  }

  if (!status.isClean) {
    flags.push(
      <Text key="modified" color="yellow">
        M
      </Text>,
    );
  }
  if (status.hasUnpushedCommits) {
    flags.push(
      status.fullyPushedUpstreamDeleted ? (
        <Text key="unpushed" color="green">
          ⇡
        </Text>
      ) : (
        <Text key="unpushed" color="cyan">
          ↑
        </Text>
      ),
    );
  }
  if (status.hasStashedChanges) {
    flags.push(
      <Text key="stash" color="magenta">
        S
      </Text>,
    );
  }
  if (status.hasOperationInProgress) {
    flags.push(
      <Text key="operation" color="red">
        ⚠
      </Text>,
    );
  }
  if (status.hasModifiedSubmodules) {
    flags.push(
      <Text key="submodules" color="yellow">
        ⊞
      </Text>,
    );
  }
  if (status.upstreamGone) {
    flags.push(
      <Text key="upstream" color="red" dimColor>
        ✗
      </Text>,
    );
  }

  return <>{flags}</>;
};

const getStatusSummary = (status: WorktreeStatusResult): string => {
  const parts: string[] = [];
  const details = status.details;

  if (!status.isClean && details) {
    const fileCount =
      details.modifiedFiles +
      details.deletedFiles +
      details.renamedFiles +
      details.createdFiles +
      details.conflictedFiles +
      details.untrackedFiles;
    if (fileCount > 0) parts.push(`${fileCount} changed`);
  }
  if (status.hasUnpushedCommits && details?.unpushedCommitCount) {
    parts.push(
      status.fullyPushedUpstreamDeleted ? "pushed, remote branch deleted" : `${details.unpushedCommitCount} unpushed`,
    );
  }
  if (status.hasStashedChanges && details?.stashCount) {
    parts.push(`${details.stashCount} stash`);
  }
  if (status.hasOperationInProgress && details?.operationType) {
    parts.push(`${details.operationType} in progress`);
  }
  if (status.upstreamGone) {
    parts.push("upstream gone");
  }

  return parts.length > 0 ? `(${parts.join(", ")})` : "";
};

const formatDivergedDate = (dateStr: string): string => {
  if (!dateStr) return "unknown date";
  if (dateStr.length === 10) return dateStr;
  try {
    return new Date(dateStr).toLocaleDateString("en-CA");
  } catch {
    return dateStr;
  }
};

const WorktreeStatusView: React.FC<WorktreeStatusViewProps> = ({
  repositories,
  getWorktreeStatusForRepo,
  getRepositoryDiskUsage,
  getDivergedDirectoriesForRepo,
  deleteDivergedDirectory,
  onClose,
  availableRows,
}) => {
  const layout = useModalLayout(70, availableRows);
  const [step, setStep] = useState<ViewStep>(repositories.length > 1 ? "SELECT_PROJECT" : "VIEW_STATUS");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0);
  const [projectFilter, setProjectFilter] = useState("");
  const selectedRepoIndexRef = useRef<number>(repositories.length === 1 ? repositories[0].index : -1);

  const [entries, setEntries] = useState<WorktreeStatusEntry[]>([]);
  const [divergedEntries, setDivergedEntries] = useState<DivergedDirectoryInfo[]>([]);
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0);
  const [entryFilter, setEntryFilter] = useState("");
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // What ends the "not loaded yet" state is a load that finished, not a
  // non-empty list: a repo with no worktrees (clone mode before the first sync)
  // and one whose every status probe rejected both leave the list at [], and
  // keying the effect on `entries.length === 0` re-fired the loader on every
  // commit for as long as the modal stayed open -- a git spawn and a readdir of
  // .diverged per round trip, forever. Keyed by repository index so picking
  // another project still loads exactly once, and reset when ESC goes back to
  // that choice.
  const loadedForRepoRef = useRef<number | null>(null);
  const [repoDiskUsage, setRepoDiskUsage] = useState<Record<number, RepositoryDiskUsageState>>({});
  const requestedDiskUsageRef = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);

  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A failed delete stays on the list it was pressed in; the ERROR step would
  // throw the whole view away for one directory that could not be removed.
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  const filteredProjects = useMemo(() => {
    if (!projectFilter) return repositories;
    const lowerFilter = projectFilter.toLowerCase();
    return repositories.filter((repo) => repo.name.toLowerCase().includes(lowerFilter));
  }, [repositories, projectFilter]);

  const filteredEntries = useMemo(() => {
    if (!entryFilter) return entries;
    const lowerFilter = entryFilter.toLowerCase();
    return entries.filter((entry) => entry.branch.toLowerCase().includes(lowerFilter));
  }, [entries, entryFilter]);

  const filteredDiverged = useMemo(() => {
    if (!entryFilter) return divergedEntries;
    const lowerFilter = entryFilter.toLowerCase();
    return divergedEntries.filter((entry) => entry.originalBranch.toLowerCase().includes(lowerFilter));
  }, [divergedEntries, entryFilter]);

  // One predicate for all three readers -- the count, the row's `!` and the
  // detail line. On truthiness an `error: ""` was counted above the list and
  // then rendered as an ordinary status row, so the count and the rows
  // disagreed about the same entry.
  const unprobedCount = useMemo(() => entries.filter((entry) => entry.error !== undefined).length, [entries]);

  const combinedList = useMemo((): ListItem[] => {
    const items: ListItem[] = filteredEntries.map((entry) => ({ type: "worktree" as const, entry }));
    if (filteredDiverged.length > 0) {
      items.push({ type: "separator" as const });
      for (const entry of filteredDiverged) {
        items.push({ type: "diverged" as const, entry });
      }
    }
    return items;
  }, [filteredEntries, filteredDiverged]);

  const selectableIndices = useMemo(() => {
    return combinedList.reduce<number[]>((acc, item, idx) => {
      if (item.type !== "separator") acc.push(idx);
      return acc;
    }, []);
  }, [combinedList]);

  const loadStatus = useCallback(
    async (repoIndex: number) => {
      setLoading(true);
      try {
        const [statusEntries, divergedDirs] = await Promise.all([
          getWorktreeStatusForRepo(repoIndex),
          getDivergedDirectoriesForRepo?.(repoIndex) ?? Promise.resolve([]),
        ]);
        setEntries(statusEntries);
        setDivergedEntries(divergedDirs);
        setSelectedEntryIndex(0);
        setExpandedEntry(null);
        setConfirmDelete(null);
      } catch (err) {
        setError(`Failed to load worktree status: ${String(err)}`);
        setStep("ERROR");
      }
      setLoading(false);
    },
    [getWorktreeStatusForRepo, getDivergedDirectoriesForRepo],
  );

  // Unmount, not "this effect run". The effect below re-runs whenever the
  // caller hands in a new `repositories` array (the App keeps one per open
  // modal, but nothing here should depend on that). A per-run cancelled flag
  // would discard the in-flight du result, while the re-run skipped the index
  // it had already recorded in requestedDiskUsageRef -- so nothing would ever
  // replace `calculating...` until the modal was closed and reopened.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!getRepositoryDiskUsage) return;

    const indexesToLoad = repositories
      .map((repo) => repo.index)
      .filter((repoIndex) => !requestedDiskUsageRef.current.has(repoIndex));

    for (const repoIndex of indexesToLoad) {
      requestedDiskUsageRef.current.add(repoIndex);
      setRepoDiskUsage((prev) => ({ ...prev, [repoIndex]: { status: "loading" } }));

      void getRepositoryDiskUsage(repoIndex)
        .then((usage) => {
          if (!mountedRef.current) return;
          setRepoDiskUsage((prev) => ({ ...prev, [repoIndex]: { status: "ready", usage } }));
        })
        .catch(() => {
          if (!mountedRef.current) return;
          setRepoDiskUsage((prev) => ({
            ...prev,
            [repoIndex]: { status: "error" },
          }));
        });
    }
  }, [repositories, getRepositoryDiskUsage]);

  // One loader call per selected repository, from one place. The ref, not the
  // identity of `loadStatus`, is what keeps it to one: a caller that hands in a
  // fresh `getWorktreeStatusForRepo` on every render must not re-run the load.
  useEffect(() => {
    const repoIndex = selectedRepoIndexRef.current;
    if (step !== "VIEW_STATUS" || repoIndex < 0) return;
    if (loadedForRepoRef.current === repoIndex) return;
    loadedForRepoRef.current = repoIndex;
    void loadStatus(repoIndex);
  }, [step, loadStatus]);

  const navigateUp = useCallback(() => {
    setSelectedEntryIndex((prev) => {
      const currentSelectableIdx = selectableIndices.indexOf(prev);
      if (currentSelectableIdx <= 0) return selectableIndices[0] ?? 0;
      return selectableIndices[currentSelectableIdx - 1];
    });
  }, [selectableIndices]);

  const navigateDown = useCallback(() => {
    setSelectedEntryIndex((prev) => {
      const currentSelectableIdx = selectableIndices.indexOf(prev);
      if (currentSelectableIdx === -1) return selectableIndices[0] ?? 0;
      if (currentSelectableIdx >= selectableIndices.length - 1) return prev;
      return selectableIndices[currentSelectableIdx + 1];
    });
  }, [selectableIndices]);

  const selectedItem = combinedList[selectedEntryIndex];
  const isDivergedSelected = selectedItem?.type === "diverged";

  useInput((input, key) => {
    // Filters here append any printable `input`, and Ink hands mouse reports
    // through as one. Without this a scroll lands in the filter box as garbage.
    if (isMouseSequence(input)) return;

    // The confirmation stays up until the delete resolves, so without this the
    // repeat of an impatient `y` fires another removal for the same directory
    // (each queuing on the repo lock), and `n`/ESC hands the list back while a
    // delete is still running — leaving the next confirmation showing
    // "Deleting..." for an entry nothing is deleting.
    if (deleting) return;

    if (confirmDelete !== null) {
      if (input === "y" || input === "Y") {
        const item = combinedList[confirmDelete];
        if (item?.type === "diverged" && deleteDivergedDirectory && selectedRepoIndexRef.current >= 0) {
          setDeleting(true);
          deleteDivergedDirectory(selectedRepoIndexRef.current, item.entry.name)
            .then(() => {
              setDivergedEntries((prev) => prev.filter((d) => d.name !== item.entry.name));
              setConfirmDelete(null);
              setDeleting(false);
              setExpandedEntry(null);
            })
            .catch((err: unknown) => {
              setDeleteError(`Failed to delete ${item.entry.name}: ${getErrorMessage(err)}`);
              setConfirmDelete(null);
              setDeleting(false);
            });
        }
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setConfirmDelete(null);
        return;
      }
      return;
    }

    if (key.escape) {
      if (step === "SELECT_PROJECT") {
        onClose();
      } else if (step === "VIEW_STATUS") {
        if (repositories.length > 1) {
          setEntries([]);
          setDivergedEntries([]);
          setEntryFilter("");
          setExpandedEntry(null);
          setConfirmDelete(null);
          setDeleteError(null);
          selectedRepoIndexRef.current = -1;
          loadedForRepoRef.current = null;
          setStep("SELECT_PROJECT");
        } else {
          onClose();
        }
      } else if (step === "ERROR") {
        onClose();
      }
      return;
    }

    if (step === "SELECT_PROJECT") {
      if (isListUp(input, key)) {
        setSelectedProjectIndex((prev) => Math.max(0, prev - 1));
      } else if (isListDown(input, key)) {
        if (filteredProjects.length > 0) {
          setSelectedProjectIndex((prev) => Math.min(filteredProjects.length - 1, prev + 1));
        }
      } else if (key.return && filteredProjects.length > 0) {
        const selectedRepo = filteredProjects[selectedProjectIndex];
        if (selectedRepo) {
          selectedRepoIndexRef.current = selectedRepo.index;
          // The effect owns the call; this only keeps the first frame of the
          // next step from claiming there are no worktrees before it runs.
          setLoading(true);
          setStep("VIEW_STATUS");
        }
      } else if (key.backspace || key.delete) {
        setProjectFilter((prev) => prev.slice(0, -1));
        setSelectedProjectIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setProjectFilter((prev) => prev + input);
        setSelectedProjectIndex(0);
      }
    } else if (step === "VIEW_STATUS" && !loading) {
      if (isListUp(input, key)) {
        navigateUp();
      } else if (isListDown(input, key)) {
        navigateDown();
      } else if (key.return && combinedList.length > 0) {
        setExpandedEntry((prev) => (prev === selectedEntryIndex ? null : selectedEntryIndex));
      } else if (key.ctrl && input === "d") {
        // Ctrl-D, not a bare `d`: the list is also a type-to-filter box, and a
        // printable key that deletes whenever a diverged row happens to be
        // selected made `d` impossible to type into the filter.
        if (isDivergedSelected && deleteDivergedDirectory) {
          setDeleteError(null);
          setConfirmDelete(selectedEntryIndex);
        }
      } else if (key.backspace || key.delete) {
        setEntryFilter((prev) => prev.slice(0, -1));
        setSelectedEntryIndex(0);
        setExpandedEntry(null);
      } else if (input && !key.ctrl && !key.meta) {
        setEntryFilter((prev) => prev + input);
        setSelectedEntryIndex(0);
        setExpandedEntry(null);
      }
    } else if (step === "ERROR") {
      onClose();
    }
  });

  usePaste((text) => {
    if (confirmDelete !== null) return;
    if (step === "SELECT_PROJECT") {
      setProjectFilter((prev) => prev + text);
      setSelectedProjectIndex(0);
    } else if (step === "VIEW_STATUS" && !loading) {
      setEntryFilter((prev) => prev + text);
      setSelectedEntryIndex(0);
      setExpandedEntry(null);
    }
  });

  const getStepNumber = () => {
    if (repositories.length === 1) return 1;
    return step === "SELECT_PROJECT" ? 1 : 2;
  };

  const getTotalSteps = () => (repositories.length === 1 ? 1 : 2);

  // Rows the step's list may take: what the modal has, less its chrome, the
  // step's own lines above the list and a footer that wraps on a narrow box.
  const listRoom = (linesAboveList: number): number => {
    const footer = footerText();
    const footerExtra = footer ? wrappedRows(footer, layout.innerWidth) - 1 : 0;
    return layout.rows - layout.chromeRows - linesAboveList - footerExtra;
  };

  const detailRows = (lines: DetailLine[]): number =>
    lines.reduce((sum, line) => sum + wrappedRows(line.text, layout.innerWidth - DETAIL_INDENT), 0) + 1;

  const renderDetailLines = (lines: DetailLine[]) => (
    <Box flexDirection="column" marginLeft={DETAIL_INDENT} marginTop={0} marginBottom={1}>
      {lines.map((line, index) => (
        <Text key={index} color={line.color} dimColor={line.dim}>
          {line.text}
        </Text>
      ))}
    </Box>
  );

  const renderProjectSelection = () => {
    // "Select repository:", the filter, and the gaps after each.
    const visibleCount = listRowsFor(listRoom(4), filteredProjects.length);
    const { start: startIdx, end: endIdx } = listWindow(selectedProjectIndex, filteredProjects.length, visibleCount);

    const visibleProjects = filteredProjects.slice(startIdx, endIdx);

    return (
      <Box flexDirection="column" gap={1}>
        <Text>Select repository:</Text>
        <Box>
          <Text>Filter: </Text>
          <Text color="cyan">{projectFilter || "_"}</Text>
          <Text dimColor>
            {" "}
            ({filteredProjects.length}/{repositories.length} matches)
          </Text>
        </Box>
        <Box flexDirection="column">
          {filteredProjects.length === 0 ? (
            <Text color="yellow">No matches</Text>
          ) : (
            <>
              {startIdx > 0 && <Text dimColor> ...</Text>}
              {visibleProjects.map((repo, idx) => {
                const actualIdx = startIdx + idx;
                const isSelected = actualIdx === selectedProjectIndex;
                return (
                  <Box key={repo.index}>
                    <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "> " : "  "}</Text>
                    <Box width={38}>
                      <Text color={isSelected ? "cyan" : undefined} wrap="truncate-end">
                        {repo.name}
                      </Text>
                    </Box>
                    {getRepositoryDiskUsage && <Text dimColor> </Text>}
                    {renderRepositoryDiskUsage(repo.index)}
                  </Box>
                );
              })}
              {endIdx < filteredProjects.length && <Text dimColor> ...</Text>}
            </>
          )}
        </Box>
      </Box>
    );
  };

  const renderRepositoryDiskUsage = (repoIndex: number) => {
    if (!getRepositoryDiskUsage) return null;

    const state = repoDiskUsage[repoIndex];
    if (!state || state.status === "loading") {
      return <Text dimColor>Size: calculating...</Text>;
    }
    if (state.status === "error") {
      return <Text color="red">Size: N/A</Text>;
    }
    return (
      <Text>
        Size: <Text color="magenta">{state.usage.sizeFormatted}</Text>
      </Text>
    );
  };

  const selectedRepo =
    selectedRepoIndexRef.current >= 0
      ? repositories.find((repo) => repo.index === selectedRepoIndexRef.current)
      : undefined;

  const renderStatusList = () => {
    if (loading) {
      return <Text color="yellow">Loading worktree status...</Text>;
    }

    if (entries.length === 0 && divergedEntries.length === 0) {
      return <Text color="red">No worktrees found</Text>;
    }

    // The repository line and its margin, the filter, the probe warning, and
    // the gap before the list. Inside the list, the diverged separator's
    // margin and an expanded entry's detail panel take rows no entry is
    // counted for.
    const linesAbove = (selectedRepo ? 2 : 0) + 1 + (unprobedCount > 0 ? 1 : 0) + 1;
    const expandedItem = expandedEntry !== null ? combinedList[expandedEntry] : undefined;
    const expandedRows =
      expandedItem?.type === "worktree"
        ? detailRows(worktreeDetailLines(expandedItem.entry))
        : expandedItem?.type === "diverged"
          ? detailRows(divergedDetailLines(expandedItem.entry))
          : 0;
    // A failed delete's message sits under the list, with its margin.
    const deleteErrorRows = deleteError ? 1 + wrappedRows(deleteError, layout.innerWidth) : 0;
    const extraRows = (filteredDiverged.length > 0 ? 1 : 0) + expandedRows + deleteErrorRows;
    const visibleCount = listRowsFor(listRoom(linesAbove) - extraRows, combinedList.length);
    const { start: startIdx, end: endIdx } = listWindow(selectedEntryIndex, combinedList.length, visibleCount);

    const visibleItems = combinedList.slice(startIdx, endIdx);
    const filteredCount = filteredEntries.length + filteredDiverged.length;

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box>
            <Text>Filter: </Text>
            <Text color="cyan">{entryFilter || "_"}</Text>
            <Text dimColor>
              {" "}
              ({filteredCount}/{entries.length + divergedEntries.length} matches)
            </Text>
          </Box>
          {unprobedCount > 0 && (
            <Text color="red">
              ⚠ {unprobedCount} of {entries.length} worktrees could not be probed
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          {filteredCount === 0 ? (
            <Text color="yellow">No matches</Text>
          ) : (
            <>
              {startIdx > 0 && <Text dimColor> ...</Text>}
              {visibleItems.map((item, idx) => {
                const actualIdx = startIdx + idx;

                if (item.type === "separator") {
                  return (
                    <Box key="separator" marginTop={1}>
                      <Text dimColor>── Diverged Directories ──</Text>
                    </Box>
                  );
                }

                if (item.type === "worktree") {
                  const isSelected = actualIdx === selectedEntryIndex;
                  const isExpanded = expandedEntry === actualIdx;
                  const summary = getStatusSummary(item.entry.status);

                  return (
                    <Box key={item.entry.path} flexDirection="column">
                      <Box>
                        <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "> " : "  "}</Text>
                        <Box width={24}>
                          <Text color={isSelected ? "cyan" : undefined} wrap="truncate-end">
                            {item.entry.branch}
                          </Text>
                        </Box>
                        <Text> </Text>
                        {item.entry.error !== undefined ? (
                          <Text color="red">! status unknown</Text>
                        ) : (
                          <>
                            {/* A narrow box squeezes the branch and summary, never a flag. */}
                            <Box flexShrink={0}>{getStatusFlags(item.entry.status)}</Box>
                            {summary && (
                              <Text dimColor wrap="truncate-end">
                                {" "}
                                {summary}
                              </Text>
                            )}
                          </>
                        )}
                      </Box>
                      {isExpanded && renderDetailLines(worktreeDetailLines(item.entry))}
                    </Box>
                  );
                }

                const isSelected = actualIdx === selectedEntryIndex;
                const isExpanded = expandedEntry === actualIdx;
                const isConfirming = confirmDelete === actualIdx;
                const dateStr = formatDivergedDate(item.entry.divergedAt);

                return (
                  <Box key={item.entry.path} flexDirection="column">
                    <Box>
                      <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "> " : "  "}</Text>
                      {isConfirming ? (
                        deleting ? (
                          <Text color="yellow">Deleting...</Text>
                        ) : (
                          <Text color="red">Delete {item.entry.name}? (y/n)</Text>
                        )
                      ) : (
                        <>
                          <Text color={isSelected ? "cyan" : "yellow"}>📦 </Text>
                          <Box width={24}>
                            <Text color={isSelected ? "cyan" : undefined} wrap="truncate-end">
                              {item.entry.originalBranch}
                            </Text>
                          </Box>
                          <Text dimColor> {item.entry.sizeFormatted.padStart(10)}</Text>
                          <Text dimColor wrap="truncate-end">
                            {" "}
                            (diverged {dateStr})
                          </Text>
                        </>
                      )}
                    </Box>
                    {isExpanded && !isConfirming && renderDetailLines(divergedDetailLines(item.entry))}
                  </Box>
                );
              })}
              {endIdx < combinedList.length && <Text dimColor> ...</Text>}
            </>
          )}
        </Box>
      </Box>
    );
  };

  const renderError = () => (
    <Box flexDirection="column" gap={1}>
      <Text color="red">Error: {error}</Text>
      <Text dimColor>Press any key to close</Text>
    </Box>
  );

  const renderContent = () => {
    switch (step) {
      case "SELECT_PROJECT":
        return renderProjectSelection();
      case "VIEW_STATUS":
        return renderStatusList();
      case "ERROR":
        return renderError();
    }
  };

  function footerText(): string | null {
    if (step === "ERROR") return null;
    if (step === "VIEW_STATUS" && loading) return null;
    if (confirmDelete !== null) {
      return "y to confirm • n or ESC to cancel";
    }
    if (step === "VIEW_STATUS") {
      return isDivergedSelected
        ? "Ctrl-D to delete • ↑/↓ navigate • Type to filter • Enter to expand • ESC to close"
        : "↑/↓ navigate • Type to filter • Enter to expand • ESC to close";
    }
    return "↑/↓ navigate • Type to filter • Enter to select • ESC to cancel";
  }

  const renderFooter = () => {
    const footer = footerText();
    return footer ? <Text dimColor>{footer}</Text> : null;
  };

  return (
    <Box flexDirection="column" marginTop={layout.marginY} marginBottom={layout.marginY}>
      <Box
        borderStyle="round"
        borderColor="green"
        paddingX={2}
        paddingY={layout.paddingY}
        flexDirection="column"
        width={layout.width}
      >
        <Box marginBottom={1}>
          <Text bold color="green">
            📊 Worktree Status{" "}
            {step !== "ERROR" && (
              <Text dimColor>
                (Step {getStepNumber()}/{getTotalSteps()})
              </Text>
            )}
          </Text>
        </Box>

        {step === "VIEW_STATUS" && selectedRepo && (
          <Box marginBottom={1}>
            <Text>
              Repository: <Text color="cyan">{selectedRepo.name}</Text>
            </Text>
            {getRepositoryDiskUsage && <Text dimColor> </Text>}
            {renderRepositoryDiskUsage(selectedRepo.index)}
          </Box>
        )}

        {renderContent()}

        {step === "VIEW_STATUS" && deleteError && (
          <Box marginTop={1}>
            <Text color="red">{deleteError}</Text>
          </Box>
        )}

        <Box marginTop={1}>{renderFooter()}</Box>
      </Box>
    </Box>
  );
};

export default WorktreeStatusView;
