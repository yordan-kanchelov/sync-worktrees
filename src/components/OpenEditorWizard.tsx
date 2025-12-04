import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";

type WizardStep = "SELECT_PROJECT" | "SELECT_WORKTREE" | "OPENING" | "ERROR";

export interface OpenEditorWizardProps {
  repositories: Array<{ index: number; name: string; repoUrl: string }>;
  getWorktreesForRepo: (index: number) => Promise<Array<{ path: string; branch: string }>>;
  openEditorInWorktree: (worktreePath: string) => { success: boolean; error?: string };
  onClose: () => void;
}

const OpenEditorWizard: React.FC<OpenEditorWizardProps> = ({
  repositories,
  getWorktreesForRepo,
  openEditorInWorktree,
  onClose,
}) => {
  const [step, setStep] = useState<WizardStep>(repositories.length > 1 ? "SELECT_PROJECT" : "SELECT_WORKTREE");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0);
  const [projectFilter, setProjectFilter] = useState("");
  const selectedRepoIndexRef = useRef<number>(repositories.length === 1 ? 0 : -1);

  const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string }>>([]);
  const [selectedWorktreeIndex, setSelectedWorktreeIndex] = useState(0);
  const [worktreeFilter, setWorktreeFilter] = useState("");
  const [loading, setLoading] = useState(false);

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
      setLoading(true);
      try {
        const wts = await getWorktreesForRepo(repoIndex);
        setWorktrees(wts);
        setSelectedWorktreeIndex(0);
      } catch (err) {
        setError(`Failed to load worktrees: ${err}`);
        setStep("ERROR");
      }
      setLoading(false);
    },
    [getWorktreesForRepo],
  );

  useEffect(() => {
    if (step === "SELECT_WORKTREE" && worktrees.length === 0 && !loading && selectedRepoIndexRef.current >= 0) {
      loadWorktrees(selectedRepoIndexRef.current);
    }
  }, [step, worktrees.length, loading, loadWorktrees]);

  const handleOpenEditor = () => {
    const worktree = filteredWorktrees[selectedWorktreeIndex];
    if (!worktree) return;

    setStep("OPENING");
    const result = openEditorInWorktree(worktree.path);
    if (result.success) {
      onClose();
    } else {
      setError(result.error || "Failed to open editor");
      setStep("ERROR");
    }
  };

  useInput((input, key) => {
    if (step === "OPENING") return;

    if (key.escape) {
      if (step === "SELECT_PROJECT") {
        onClose();
      } else if (step === "SELECT_WORKTREE") {
        if (repositories.length > 1) {
          setWorktrees([]);
          setWorktreeFilter("");
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
          setStep("SELECT_WORKTREE");
          loadWorktrees(selectedRepo.index);
        }
      } else if (key.backspace || key.delete) {
        setProjectFilter((prev) => prev.slice(0, -1));
        setSelectedProjectIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setProjectFilter((prev) => prev + input);
        setSelectedProjectIndex(0);
      }
    } else if (step === "SELECT_WORKTREE") {
      if (key.upArrow) {
        setSelectedWorktreeIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedWorktreeIndex((prev) => Math.min(filteredWorktrees.length - 1, prev + 1));
      } else if (key.return && filteredWorktrees.length > 0) {
        handleOpenEditor();
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

  const getStepNumber = () => {
    if (repositories.length === 1) {
      return 1;
    }
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

  const renderWorktreeSelection = () => {
    if (loading) {
      return <Text color="yellow">Loading worktrees...</Text>;
    }

    if (worktrees.length === 0) {
      return <Text color="red">No worktrees found</Text>;
    }

    const visibleCount = 8;
    const halfVisible = Math.floor(visibleCount / 2);
    let startIdx = Math.max(0, selectedWorktreeIndex - halfVisible);
    const endIdx = Math.min(filteredWorktrees.length, startIdx + visibleCount);
    if (endIdx - startIdx < visibleCount) {
      startIdx = Math.max(0, endIdx - visibleCount);
    }

    const visibleWorktrees = filteredWorktrees.slice(startIdx, endIdx);

    return (
      <Box flexDirection="column" gap={1}>
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
                    <Text color={isSelected ? "cyan" : undefined}>
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

  const renderOpening = () => (
    <Box flexDirection="column" gap={1}>
      <Text color="yellow">Opening editor...</Text>
    </Box>
  );

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
      case "OPENING":
        return renderOpening();
      case "ERROR":
        return renderError();
    }
  };

  const renderFooter = () => {
    if (step === "OPENING") return null;
    if (step === "ERROR") return null;
    return <Text dimColor>↑/↓ navigate • Type to filter • Enter to select • ESC to cancel</Text>;
  };

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box borderStyle="round" borderColor="blue" paddingX={2} paddingY={1} flexDirection="column" width={60}>
        <Box marginBottom={1}>
          <Text bold color="blue">
            📂 Open in Editor{" "}
            {step !== "OPENING" && step !== "ERROR" && (
              <Text dimColor>
                (Step {getStepNumber()}/{getTotalSteps()})
              </Text>
            )}
          </Text>
        </Box>

        {repositories.length > 1 && step === "SELECT_WORKTREE" && !loading && selectedRepoIndexRef.current >= 0 && (
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

export default OpenEditorWizard;
