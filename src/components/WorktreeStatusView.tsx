import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";

import type { WorktreeStatusResult } from "../services/worktree-status.service";
import type { WorktreeStatusEntry } from "../types";

export type { WorktreeStatusEntry };

type ViewStep = "SELECT_PROJECT" | "VIEW_STATUS" | "ERROR";

export interface WorktreeStatusViewProps {
  repositories: Array<{ index: number; name: string; repoUrl: string }>;
  getWorktreeStatusForRepo: (index: number) => Promise<WorktreeStatusEntry[]>;
  onClose: () => void;
}

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
      <Text key="unpushed" color="cyan">
        ↑
      </Text>,
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
      details.modifiedFiles + details.deletedFiles + details.renamedFiles + details.createdFiles + details.conflictedFiles + details.untrackedFiles;
    if (fileCount > 0) parts.push(`${fileCount} changed`);
  }
  if (status.hasUnpushedCommits && details?.unpushedCommitCount) {
    parts.push(`${details.unpushedCommitCount} unpushed`);
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

const WorktreeStatusView: React.FC<WorktreeStatusViewProps> = ({ repositories, getWorktreeStatusForRepo, onClose }) => {
  const [step, setStep] = useState<ViewStep>(repositories.length > 1 ? "SELECT_PROJECT" : "VIEW_STATUS");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0);
  const [projectFilter, setProjectFilter] = useState("");
  const selectedRepoIndexRef = useRef<number>(repositories.length === 1 ? 0 : -1);

  const [entries, setEntries] = useState<WorktreeStatusEntry[]>([]);
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0);
  const [entryFilter, setEntryFilter] = useState("");
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

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

  const loadStatus = useCallback(
    async (repoIndex: number) => {
      setLoading(true);
      try {
        const statusEntries = await getWorktreeStatusForRepo(repoIndex);
        setEntries(statusEntries);
        setSelectedEntryIndex(0);
        setExpandedEntry(null);
      } catch (err) {
        setError(`Failed to load worktree status: ${err}`);
        setStep("ERROR");
      }
      setLoading(false);
    },
    [getWorktreeStatusForRepo],
  );

  useEffect(() => {
    if (step === "VIEW_STATUS" && entries.length === 0 && !loading && selectedRepoIndexRef.current >= 0) {
      loadStatus(selectedRepoIndexRef.current);
    }
  }, [step, entries.length, loading, loadStatus]);

  useInput((input, key) => {
    if (key.escape) {
      if (step === "SELECT_PROJECT") {
        onClose();
      } else if (step === "VIEW_STATUS") {
        if (repositories.length > 1) {
          setEntries([]);
          setEntryFilter("");
          setExpandedEntry(null);
          selectedRepoIndexRef.current = -1;
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
      if (key.upArrow) {
        setSelectedProjectIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedProjectIndex((prev) => Math.min(filteredProjects.length - 1, prev + 1));
      } else if (key.return && filteredProjects.length > 0) {
        const selectedRepo = filteredProjects[selectedProjectIndex];
        if (selectedRepo) {
          selectedRepoIndexRef.current = selectedRepo.index;
          setStep("VIEW_STATUS");
          loadStatus(selectedRepo.index);
        }
      } else if (key.backspace || key.delete) {
        setProjectFilter((prev) => prev.slice(0, -1));
        setSelectedProjectIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setProjectFilter((prev) => prev + input);
        setSelectedProjectIndex(0);
      }
    } else if (step === "VIEW_STATUS" && !loading) {
      if (key.upArrow) {
        setSelectedEntryIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedEntryIndex((prev) => Math.min(filteredEntries.length - 1, prev + 1));
      } else if (key.return && filteredEntries.length > 0) {
        setExpandedEntry((prev) => (prev === selectedEntryIndex ? null : selectedEntryIndex));
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

  const getStepNumber = () => {
    if (repositories.length === 1) return 1;
    return step === "SELECT_PROJECT" ? 1 : 2;
  };

  const getTotalSteps = () => (repositories.length === 1 ? 1 : 2);

  const renderProjectSelection = () => {
    const visibleCount = 8;
    const halfVisible = Math.floor(visibleCount / 2);
    let startIdx = Math.max(0, selectedProjectIndex - halfVisible);
    const endIdx = Math.min(filteredProjects.length, startIdx + visibleCount);
    if (endIdx - startIdx < visibleCount) {
      startIdx = Math.max(0, endIdx - visibleCount);
    }

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
                    <Text color={isSelected ? "cyan" : undefined}>
                      {isSelected ? "> " : "  "}
                      {repo.name}
                    </Text>
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

  const renderDetailPanel = (entry: WorktreeStatusEntry) => {
    const { status } = entry;
    const details = status.details;

    return (
      <Box flexDirection="column" marginLeft={4} marginTop={0} marginBottom={1}>
        <Text dimColor>Path: {entry.path}</Text>
        {details && (
          <>
            {details.modifiedFiles > 0 && <Text color="yellow"> Modified: {details.modifiedFiles}</Text>}
            {details.deletedFiles > 0 && <Text color="red"> Deleted: {details.deletedFiles}</Text>}
            {details.createdFiles > 0 && <Text color="green"> Created: {details.createdFiles}</Text>}
            {details.renamedFiles > 0 && <Text color="blue"> Renamed: {details.renamedFiles}</Text>}
            {details.untrackedFiles > 0 && <Text color="gray"> Untracked: {details.untrackedFiles}</Text>}
            {details.conflictedFiles > 0 && <Text color="red"> Conflicted: {details.conflictedFiles}</Text>}
            {(details.unpushedCommitCount ?? 0) > 0 && (
              <Text color="cyan"> Unpushed commits: {details.unpushedCommitCount}</Text>
            )}
            {(details.stashCount ?? 0) > 0 && <Text color="magenta"> Stashes: {details.stashCount}</Text>}
            {details.operationType && <Text color="red"> Operation: {details.operationType}</Text>}
            {details.modifiedSubmodules && details.modifiedSubmodules.length > 0 && (
              <Text color="yellow"> Modified submodules: {details.modifiedSubmodules.join(", ")}</Text>
            )}
          </>
        )}
        {status.upstreamGone && <Text color="red"> Remote branch has been deleted</Text>}
        {status.reasons.length > 0 && (
          <Text dimColor> Reasons: {status.reasons.join(", ")}</Text>
        )}
      </Box>
    );
  };

  const renderStatusList = () => {
    if (loading) {
      return <Text color="yellow">Loading worktree status...</Text>;
    }

    if (entries.length === 0) {
      return <Text color="red">No worktrees found</Text>;
    }

    const visibleCount = 8;
    const halfVisible = Math.floor(visibleCount / 2);
    let startIdx = Math.max(0, selectedEntryIndex - halfVisible);
    const endIdx = Math.min(filteredEntries.length, startIdx + visibleCount);
    if (endIdx - startIdx < visibleCount) {
      startIdx = Math.max(0, endIdx - visibleCount);
    }

    const visibleEntries = filteredEntries.slice(startIdx, endIdx);

    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text>Filter: </Text>
          <Text color="cyan">{entryFilter || "_"}</Text>
          <Text dimColor>
            {" "}
            ({filteredEntries.length}/{entries.length} matches)
          </Text>
        </Box>
        <Box flexDirection="column">
          {filteredEntries.length === 0 ? (
            <Text color="yellow">No matches</Text>
          ) : (
            <>
              {startIdx > 0 && <Text dimColor> ...</Text>}
              {visibleEntries.map((entry, idx) => {
                const actualIdx = startIdx + idx;
                const isSelected = actualIdx === selectedEntryIndex;
                const isExpanded = expandedEntry === actualIdx;
                const summary = getStatusSummary(entry.status);

                return (
                  <Box key={entry.path} flexDirection="column">
                    <Box>
                      <Text color={isSelected ? "cyan" : undefined}>
                        {isSelected ? "> " : "  "}
                      </Text>
                      <Box width={24}>
                        <Text color={isSelected ? "cyan" : undefined}>{entry.branch}</Text>
                      </Box>
                      <Text> </Text>
                      {getStatusFlags(entry.status)}
                      {summary && (
                        <Text dimColor> {summary}</Text>
                      )}
                    </Box>
                    {isExpanded && renderDetailPanel(entry)}
                  </Box>
                );
              })}
              {endIdx < filteredEntries.length && <Text dimColor> ...</Text>}
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

  const renderFooter = () => {
    if (step === "ERROR") return null;
    if (step === "VIEW_STATUS" && loading) return null;
    return (
      <Text dimColor>
        {step === "VIEW_STATUS"
          ? "↑/↓ navigate • Type to filter • Enter to expand • ESC to close"
          : "↑/↓ navigate • Type to filter • Enter to select • ESC to cancel"}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" width={70}>
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

        {repositories.length > 1 && step === "VIEW_STATUS" && !loading && selectedRepoIndexRef.current >= 0 && (
          <Box marginBottom={1}>
            <Text>
              Repository: <Text color="cyan">{repositories.find((r) => r.index === selectedRepoIndexRef.current)?.name}</Text>
            </Text>
          </Box>
        )}

        {renderContent()}

        <Box marginTop={1}>{renderFooter()}</Box>
      </Box>
    </Box>
  );
};

export default WorktreeStatusView;
