import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { isMouseSequence } from "../utils/mouse";
import { sanitizePastedFilter } from "../utils/paste-filter";
import { isListDown, isListUp, listRowsFor, listWindow, useModalLayout, wrappedRows } from "./layout";

type WizardStep = "SELECT_PROJECT" | "SELECT_WORKTREE" | "ERROR";

export type OpenAction = "terminal" | "editor";

export interface OpenEditorWizardProps {
  repositories: Array<{ index: number; name: string; repoUrl: string }>;
  getWorktreesForRepo: (index: number) => Promise<Array<{ path: string; branch: string }>>;
  openEditorInWorktree: (worktreePath: string) => { success: boolean; error?: string };
  openTerminalInWorktree: (
    repoIndex: number,
    worktreePath: string,
    branchName: string,
  ) => { success: boolean; error?: string };
  onClose: () => void;
  availableRows?: number;
}

const OpenEditorWizard: React.FC<OpenEditorWizardProps> = ({
  repositories,
  getWorktreesForRepo,
  openEditorInWorktree,
  openTerminalInWorktree,
  onClose,
  availableRows,
}) => {
  const layout = useModalLayout(60, availableRows);
  const [step, setStep] = useState<WizardStep>(repositories.length > 1 ? "SELECT_PROJECT" : "SELECT_WORKTREE");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0);
  const [projectFilter, setProjectFilter] = useState("");
  const [selectedRepoIndex, setSelectedRepoIndex] = useState(repositories.length === 1 ? repositories[0].index : -1);

  const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string }>>([]);
  const [selectedWorktreeIndex, setSelectedWorktreeIndex] = useState(0);
  const [worktreeFilter, setWorktreeFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [openAction, setOpenAction] = useState<OpenAction>("terminal");
  const loadedForRepoRef = useRef<number | null>(null);
  const loadGenRef = useRef(0);

  const [error, setError] = useState<string | null>(null);

  const filteredProjects = useMemo(() => {
    if (!projectFilter) return repositories;
    const lowerFilter = projectFilter.toLowerCase();
    return repositories.filter((repo) => repo.name.toLowerCase().includes(lowerFilter));
  }, [repositories, projectFilter]);

  const filteredWorktrees = useMemo(() => {
    if (!worktreeFilter) return worktrees;
    const lowerFilter = worktreeFilter.toLowerCase();
    return worktrees.filter((wt) => wt.branch.toLowerCase().includes(lowerFilter));
  }, [worktrees, worktreeFilter]);

  const loadWorktrees = useCallback(
    async (repoIndex: number) => {
      const gen = ++loadGenRef.current;
      setLoading(true);
      try {
        const wts = await getWorktreesForRepo(repoIndex);
        if (gen !== loadGenRef.current) return;
        setWorktrees(wts);
        setSelectedWorktreeIndex(0);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        setError(`Failed to load worktrees: ${String(err)}`);
        setStep("ERROR");
      }
      setLoading(false);
    },
    [getWorktreesForRepo],
  );

  useEffect(() => {
    if (step !== "SELECT_WORKTREE" || selectedRepoIndex < 0) return;
    if (loadedForRepoRef.current === selectedRepoIndex) return;
    loadedForRepoRef.current = selectedRepoIndex;
    void loadWorktrees(selectedRepoIndex);
  }, [step, selectedRepoIndex, loadWorktrees]);

  const handleOpen = () => {
    const worktree = filteredWorktrees[selectedWorktreeIndex];
    if (!worktree) return;

    const result =
      openAction === "terminal"
        ? openTerminalInWorktree(selectedRepoIndex, worktree.path, worktree.branch)
        : openEditorInWorktree(worktree.path);
    if (result.success) {
      onClose();
    } else {
      setError(result.error || (openAction === "terminal" ? "Failed to open terminal" : "Failed to open editor"));
      setStep("ERROR");
    }
  };

  useInput((input, key) => {
    if (isMouseSequence(input)) return;

    if (key.escape) {
      if (step === "SELECT_PROJECT") {
        onClose();
      } else if (step === "SELECT_WORKTREE") {
        if (repositories.length > 1) {
          loadGenRef.current++;
          setLoading(false);
          setWorktrees([]);
          setWorktreeFilter("");
          setSelectedRepoIndex(-1);
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
          setSelectedRepoIndex(selectedRepo.index);
          setLoading(true);
          setStep("SELECT_WORKTREE");
        }
      } else if (key.backspace || key.delete) {
        setProjectFilter((prev) => prev.slice(0, -1));
        setSelectedProjectIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setProjectFilter((prev) => prev + input);
        setSelectedProjectIndex(0);
      }
    } else if (step === "SELECT_WORKTREE") {
      if (key.tab) {
        setOpenAction((prev) => (prev === "terminal" ? "editor" : "terminal"));
      } else if (isListUp(input, key)) {
        setSelectedWorktreeIndex((prev) => Math.max(0, prev - 1));
      } else if (isListDown(input, key)) {
        if (filteredWorktrees.length > 0) {
          setSelectedWorktreeIndex((prev) => Math.min(filteredWorktrees.length - 1, prev + 1));
        }
      } else if (key.return && filteredWorktrees.length > 0) {
        handleOpen();
      } else if (key.backspace || key.delete) {
        setWorktreeFilter((prev) => prev.slice(0, -1));
        setSelectedWorktreeIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setWorktreeFilter((prev) => prev + input);
        setSelectedWorktreeIndex(0);
      }
    } else if (step === "ERROR") {
      onClose();
    }
  });

  usePaste((text) => {
    if (step === "SELECT_PROJECT") {
      setProjectFilter((prev) => prev + sanitizePastedFilter(text));
      setSelectedProjectIndex(0);
    } else if (step === "SELECT_WORKTREE") {
      setWorktreeFilter((prev) => prev + sanitizePastedFilter(text));
      setSelectedWorktreeIndex(0);
    }
  });

  const getStepNumber = () => {
    if (repositories.length === 1) {
      return 1;
    }
    return step === "SELECT_PROJECT" ? 1 : 2;
  };

  const getTotalSteps = () => (repositories.length === 1 ? 1 : 2);

  const listRoom = (linesAboveList: number): number => {
    const footer = footerText();
    const footerExtra = footer ? wrappedRows(footer, layout.innerWidth) - 1 : 0;
    return layout.rows - layout.chromeRows - linesAboveList - footerExtra;
  };

  const renderProjectSelection = () => {
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
                    <Text color={isSelected ? "cyan" : undefined} wrap="truncate-end">
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

  const renderWorktreeSelection = () => {
    if (loading) {
      return <Text color="yellow">Loading worktrees...</Text>;
    }

    if (worktrees.length === 0) {
      return <Text color="red">No worktrees found</Text>;
    }

    const modeLine = `Mode: ${openAction === "terminal" ? "Terminal (tmux)" : "Editor"} (Tab to switch to ${openAction === "terminal" ? "Editor" : "Terminal"})`;
    const linesAbove = 5 + wrappedRows(modeLine, layout.innerWidth) + (repositories.length > 1 ? 2 : 0);
    const visibleCount = listRowsFor(listRoom(linesAbove), filteredWorktrees.length);
    const { start: startIdx, end: endIdx } = listWindow(selectedWorktreeIndex, filteredWorktrees.length, visibleCount);

    const visibleWorktrees = filteredWorktrees.slice(startIdx, endIdx);

    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text>Mode: </Text>
          <Text color="cyan" bold>
            {openAction === "terminal" ? "Terminal (tmux)" : "Editor"}
          </Text>
          <Text dimColor> (Tab to switch to {openAction === "terminal" ? "Editor" : "Terminal"})</Text>
        </Box>
        <Text>Select worktree:</Text>
        <Box>
          <Text>Filter: </Text>
          <Text color="cyan">{worktreeFilter || "_"}</Text>
          <Text dimColor>
            {" "}
            ({filteredWorktrees.length}/{worktrees.length} matches)
          </Text>
        </Box>
        <Box flexDirection="column">
          {filteredWorktrees.length === 0 ? (
            <Text color="yellow">No matches</Text>
          ) : (
            <>
              {startIdx > 0 && <Text dimColor> ...</Text>}
              {visibleWorktrees.map((wt, idx) => {
                const actualIdx = startIdx + idx;
                const isSelected = actualIdx === selectedWorktreeIndex;
                return (
                  <Box key={wt.path}>
                    <Text color={isSelected ? "cyan" : undefined} wrap="truncate-end">
                      {isSelected ? "> " : "  "}
                      {wt.branch}
                    </Text>
                  </Box>
                );
              })}
              {endIdx < filteredWorktrees.length && <Text dimColor> ...</Text>}
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
      case "SELECT_WORKTREE":
        return renderWorktreeSelection();
      case "ERROR":
        return renderError();
    }
  };

  function footerText(): string | null {
    if (step === "ERROR") return null;
    if (step === "SELECT_WORKTREE") {
      return "↑/↓ navigate • Type to filter • Tab switch mode • Enter to select • ESC to cancel";
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
        borderColor="blue"
        paddingX={2}
        paddingY={layout.paddingY}
        flexDirection="column"
        width={layout.width}
      >
        <Box marginBottom={1}>
          <Text bold color="blue">
            📂 Open Worktree{" "}
            {step !== "ERROR" && (
              <Text dimColor>
                (Step {getStepNumber()}/{getTotalSteps()})
              </Text>
            )}
          </Text>
        </Box>

        {repositories.length > 1 && step === "SELECT_WORKTREE" && !loading && selectedRepoIndex >= 0 && (
          <Box marginBottom={1}>
            <Text>
              Repository: <Text color="cyan">{repositories.find((r) => r.index === selectedRepoIndex)?.name}</Text>
            </Text>
          </Box>
        )}

        {renderContent()}

        <Box marginTop={1}>{renderFooter()}</Box>
      </Box>
    </Box>
  );
};

export default OpenEditorWizard;
