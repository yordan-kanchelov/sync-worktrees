import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Box, Text, useInput } from "ink";

import { isValidGitBranchName } from "../utils/git-validation";

type WizardStep = "SELECT_PROJECT" | "SELECT_BRANCH" | "ENTER_NAME" | "CREATING" | "RESULT";

export interface BranchCreationWizardProps {
  repositories: Array<{ index: number; name: string; repoUrl: string }>;
  getBranchesForRepo: (index: number) => Promise<string[]>;
  getDefaultBranchForRepo: (index: number) => string;
  fetchForRepo?: (index: number) => Promise<void>;
  createAndPushBranch: (
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ) => Promise<{ success: boolean; finalName: string; error?: string }>;
  onClose: () => void;
  onComplete: (success: boolean) => void;
  onBranchCreated?: (context: {
    repoIndex: number;
    baseBranch: string;
    newBranch: string;
  }) => void;
}

const BranchCreationWizard: React.FC<BranchCreationWizardProps> = ({
  repositories,
  getBranchesForRepo,
  getDefaultBranchForRepo,
  fetchForRepo,
  createAndPushBranch,
  onClose,
  onComplete,
  onBranchCreated,
}) => {
  const [step, setStep] = useState<WizardStep>(repositories.length > 1 ? "SELECT_PROJECT" : "SELECT_BRANCH");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0);
  const [selectedRepoIndex, setSelectedRepoIndex] = useState(
    repositories.length === 1 ? repositories[0].index : -1,
  );
  const [projectFilter, setProjectFilter] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string>("");
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0);
  const [branchFilter, setBranchFilter] = useState("");
  const [branchName, setBranchName] = useState("");
  const [existingSuffix, setExistingSuffix] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; finalName: string; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const branchesLoadedRef = useRef(false);
  const [isFetching, setIsFetching] = useState(false);

  const filteredProjects = useMemo(() => {
    if (!projectFilter) return repositories;
    const lowerFilter = projectFilter.toLowerCase();
    return repositories.filter((repo) => repo.name.toLowerCase().includes(lowerFilter));
  }, [repositories, projectFilter]);

  const filteredBranches = useMemo(() => {
    if (!branchFilter) return branches;
    const lowerFilter = branchFilter.toLowerCase();
    return branches.filter((branch) => branch.toLowerCase().includes(lowerFilter));
  }, [branches, branchFilter]);

  useEffect(() => {
    if (filteredProjects.length > 0) {
      setSelectedProjectIndex((prev) => Math.max(0, Math.min(prev, filteredProjects.length - 1)));
    }
  }, [filteredProjects.length]);

  useEffect(() => {
    if (filteredBranches.length > 0) {
      setSelectedBranchIndex((prev) => Math.max(0, Math.min(prev, filteredBranches.length - 1)));
    }
  }, [filteredBranches.length]);

  const loadBranches = useCallback(
    async (repoIndex: number) => {
      setLoading(true);
      setIsFetching(false);
      try {
        let branchList = await getBranchesForRepo(repoIndex);

        // If no branches found and we haven't tried fetching yet, fetch and retry
        if (branchList.length === 0 && fetchForRepo) {
          setIsFetching(true);
          await fetchForRepo(repoIndex);
          branchList = await getBranchesForRepo(repoIndex);
        }

        const defaultBr = getDefaultBranchForRepo(repoIndex);
        setBranches(branchList);
        setDefaultBranch(defaultBr);
        const defaultIndex = branchList.indexOf(defaultBr);
        setSelectedBranchIndex(defaultIndex >= 0 ? defaultIndex : 0);
      } catch {
        setBranches([]);
      }
      setLoading(false);
      setIsFetching(false);
    },
    [getBranchesForRepo, getDefaultBranchForRepo, fetchForRepo],
  );

  const checkBranchExists = useCallback(
    (name: string) => {
      if (!name.trim()) {
        setExistingSuffix(null);
        setValidationError(null);
        return;
      }

      const validation = isValidGitBranchName(name);
      if (!validation.valid) {
        setValidationError(validation.error ?? null);
        setExistingSuffix(null);
        return;
      }

      setValidationError(null);

      let suffix = 0;
      let testName = name;

      while (branches.includes(testName)) {
        suffix++;
        testName = `${name}-${suffix}`;
      }

      setExistingSuffix(suffix > 0 ? suffix : null);
    },
    [branches],
  );

  useEffect(() => {
    if (step === "SELECT_BRANCH" && !branchesLoadedRef.current && !loading && selectedRepoIndex >= 0) {
      branchesLoadedRef.current = true;
      loadBranches(selectedRepoIndex);
    }
  }, [step, selectedRepoIndex, loading, loadBranches]);

  useEffect(() => {
    if (step === "ENTER_NAME") {
      checkBranchExists(branchName);
    }
  }, [branchName, step, checkBranchExists]);

  const handleCreateBranch = async () => {
    const trimmedName = branchName.trim();
    if (!trimmedName) return;

    const validation = isValidGitBranchName(trimmedName);
    if (!validation.valid) {
      setValidationError(validation.error ?? null);
      return;
    }

    setStep("CREATING");
    const baseBranch = filteredBranches[selectedBranchIndex];
    const createResult = await createAndPushBranch(selectedRepoIndex, baseBranch, trimmedName);
    setResult(createResult);
    if (createResult.success && onBranchCreated) {
      onBranchCreated({
        repoIndex: selectedRepoIndex,
        baseBranch,
        newBranch: createResult.finalName,
      });
    }
    setStep("RESULT");
  };

  useInput((input, key) => {
    if (step === "CREATING") return;

    if (key.escape) {
      if (step === "SELECT_PROJECT") {
        onClose();
      } else if (step === "SELECT_BRANCH") {
        if (repositories.length > 1) {
          setBranches([]);
          setBranchFilter("");
          branchesLoadedRef.current = false;
          setIsFetching(false);
          setStep("SELECT_PROJECT");
        } else {
          onClose();
        }
      } else if (step === "ENTER_NAME") {
        setBranchName("");
        setExistingSuffix(null);
        setStep("SELECT_BRANCH");
      } else if (step === "RESULT") {
        onComplete(result?.success ?? false);
      }
      return;
    }

    if (step === "SELECT_PROJECT") {
      if (key.upArrow) {
        setSelectedProjectIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        if (filteredProjects.length > 0) {
          setSelectedProjectIndex((prev) => Math.min(filteredProjects.length - 1, prev + 1));
        }
      } else if (key.return && filteredProjects.length > 0) {
        const selectedRepo = filteredProjects[selectedProjectIndex];
        if (selectedRepo) {
          setSelectedRepoIndex(selectedRepo.index);
          branchesLoadedRef.current = false;
          setIsFetching(false);
          loadBranches(selectedRepo.index);
          setStep("SELECT_BRANCH");
        }
      } else if (key.backspace || key.delete) {
        setProjectFilter((prev) => prev.slice(0, -1));
        setSelectedProjectIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setProjectFilter((prev) => prev + input);
        setSelectedProjectIndex(0);
      }
    } else if (step === "SELECT_BRANCH") {
      if (key.upArrow) {
        setSelectedBranchIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        if (filteredBranches.length > 0) {
          setSelectedBranchIndex((prev) => Math.min(filteredBranches.length - 1, prev + 1));
        }
      } else if (key.return && filteredBranches.length > 0) {
        setStep("ENTER_NAME");
      } else if (key.backspace || key.delete) {
        setBranchFilter((prev) => prev.slice(0, -1));
        setSelectedBranchIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setBranchFilter((prev) => prev + input);
        setSelectedBranchIndex(0);
      }
    } else if (step === "ENTER_NAME") {
      if (key.return && branchName.trim()) {
        handleCreateBranch().catch((err) => console.error("Branch creation failed:", err));
      } else if (key.backspace || key.delete) {
        setBranchName((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        const validChar = /^[a-zA-Z0-9/._-]$/.test(input);
        if (validChar) {
          setBranchName((prev) => prev + input);
        }
      }
    } else if (step === "RESULT") {
      onComplete(result?.success ?? false);
    }
  });

  const getStepNumber = () => {
    if (repositories.length === 1) {
      if (step === "SELECT_BRANCH") return 1;
      if (step === "ENTER_NAME") return 2;
      return 2;
    }
    if (step === "SELECT_PROJECT") return 1;
    if (step === "SELECT_BRANCH") return 2;
    if (step === "ENTER_NAME") return 3;
    return 3;
  };

  const getTotalSteps = () => (repositories.length === 1 ? 2 : 3);

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
              {startIdx > 0 && <Text dimColor>  ...</Text>}
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
              {endIdx < filteredProjects.length && <Text dimColor>  ...</Text>}
            </>
          )}
        </Box>
      </Box>
    );
  };

  const renderBranchSelection = () => {
    if (loading) {
      return <Text color="yellow">Loading branches{isFetching ? " (fetching from remote...)" : "..."}</Text>;
    }

    if (branches.length === 0) {
      return <Text color="red">No branches found</Text>;
    }

    const visibleCount = 8;
    const halfVisible = Math.floor(visibleCount / 2);
    let startIdx = Math.max(0, selectedBranchIndex - halfVisible);
    const endIdx = Math.min(filteredBranches.length, startIdx + visibleCount);
    if (endIdx - startIdx < visibleCount) {
      startIdx = Math.max(0, endIdx - visibleCount);
    }

    const visibleBranches = filteredBranches.slice(startIdx, endIdx);

    return (
      <Box flexDirection="column" gap={1}>
        <Text>Select base branch:</Text>
        <Box>
          <Text>Filter: </Text>
          <Text color="cyan">{branchFilter || "_"}</Text>
          <Text dimColor>
            {" "}
            ({filteredBranches.length}/{branches.length} matches)
          </Text>
        </Box>
        <Box flexDirection="column">
          {filteredBranches.length === 0 ? (
            <Text color="yellow">No matches</Text>
          ) : (
            <>
              {startIdx > 0 && <Text dimColor>  ...</Text>}
              {visibleBranches.map((branch, idx) => {
                const actualIdx = startIdx + idx;
                const isSelected = actualIdx === selectedBranchIndex;
                const isDefault = branch === defaultBranch;
                return (
                  <Box key={branch}>
                    <Text color={isSelected ? "cyan" : undefined}>
                      {isSelected ? "> " : "  "}
                      {branch}
                      {isDefault && <Text color="green"> (default)</Text>}
                    </Text>
                  </Box>
                );
              })}
              {endIdx < filteredBranches.length && <Text dimColor>  ...</Text>}
            </>
          )}
        </Box>
      </Box>
    );
  };

  const renderNameInput = () => {
    const baseBranch = filteredBranches[selectedBranchIndex] || "";
    const finalName = existingSuffix !== null ? `${branchName}-${existingSuffix}` : branchName;
    const endsWithSlash = branchName.endsWith("/");

    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          Base branch: <Text color="cyan">{baseBranch}</Text>
        </Text>
        <Text>Enter new branch name:</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <Text>{branchName}</Text>
          <Text color="gray">|</Text>
        </Box>
        {validationError && (
          <Text color="red">{validationError}</Text>
        )}
        {!validationError && endsWithSlash && (
          <Text color="yellow" dimColor>
            Hint: consecutive slashes (//) are not allowed
          </Text>
        )}
        {!validationError && !endsWithSlash && existingSuffix !== null && branchName && (
          <Text color="yellow">
            Name exists, will create: <Text color="cyan">{finalName}</Text>
          </Text>
        )}
      </Box>
    );
  };

  const renderCreating = () => (
    <Box flexDirection="column" gap={1}>
      <Text color="yellow">Creating branch...</Text>
      <Text dimColor>Please wait while the branch is created and pushed to remote.</Text>
    </Box>
  );

  const renderResult = () => {
    if (!result) return null;

    if (result.success) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="green">Branch created successfully!</Text>
          <Text>
            Created: <Text color="cyan">{result.finalName}</Text>
          </Text>
          <Text>
            From: <Text color="cyan">{filteredBranches[selectedBranchIndex]}</Text>
          </Text>
          <Text color="green">Worktree sync started in background</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">Failed to create branch</Text>
        <Text color="red">{result.error}</Text>
      </Box>
    );
  };

  const renderContent = () => {
    switch (step) {
      case "SELECT_PROJECT":
        return renderProjectSelection();
      case "SELECT_BRANCH":
        return renderBranchSelection();
      case "ENTER_NAME":
        return renderNameInput();
      case "CREATING":
        return renderCreating();
      case "RESULT":
        return renderResult();
    }
  };

  const renderFooter = () => {
    if (step === "CREATING") return null;
    if (step === "RESULT") {
      return <Text dimColor>Press any key to close</Text>;
    }
    if (step === "ENTER_NAME") {
      return <Text dimColor>Enter to create • ESC to go back</Text>;
    }
    return <Text dimColor>↑/↓ navigate • Type to filter • Enter to select • ESC to cancel</Text>;
  };

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" width={60}>
        <Box marginBottom={1}>
          <Text bold color="green">
            🌿 Create New Branch{" "}
            {step !== "CREATING" && step !== "RESULT" && (
              <Text dimColor>
                (Step {getStepNumber()}/{getTotalSteps()})
              </Text>
            )}
          </Text>
        </Box>

        {repositories.length > 1 && step !== "SELECT_PROJECT" && step !== "CREATING" && step !== "RESULT" && (
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

export default BranchCreationWizard;
