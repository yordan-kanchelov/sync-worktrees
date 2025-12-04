import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";

const isValidGitBranchName = (name: string): { valid: boolean; error?: string } => {
  if (!name.trim()) {
    return { valid: false, error: "Branch name cannot be empty" };
  }
  if (name.startsWith("-")) {
    return { valid: false, error: "Branch name cannot start with '-'" };
  }
  if (name.endsWith(".lock")) {
    return { valid: false, error: "Branch name cannot end with '.lock'" };
  }
  if (name.includes("..")) {
    return { valid: false, error: "Branch name cannot contain '..'" };
  }
  if (name.includes("@{")) {
    return { valid: false, error: "Branch name cannot contain '@{'" };
  }
  if (name.startsWith(".") || name.endsWith(".")) {
    return { valid: false, error: "Branch name cannot start or end with '.'" };
  }
  if (name.includes("//")) {
    return { valid: false, error: "Branch name cannot contain consecutive slashes" };
  }
  if (/[\x00-\x1f\x7f~^:?*\[\\]/.test(name)) {
    return { valid: false, error: "Branch name contains invalid characters" };
  }
  return { valid: true };
};

type WizardStep = "SELECT_PROJECT" | "SELECT_BRANCH" | "ENTER_NAME" | "CREATING" | "RESULT";

export interface BranchCreationWizardProps {
  repositories: Array<{ index: number; name: string; repoUrl: string }>;
  getBranchesForRepo: (index: number) => Promise<string[]>;
  getDefaultBranchForRepo: (index: number) => string;
  createAndPushBranch: (
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ) => Promise<{ success: boolean; finalName: string; error?: string }>;
  onClose: () => void;
  onComplete: (
    success: boolean,
    context?: {
      repoIndex: number;
      baseBranch: string;
      newBranch: string;
    },
  ) => void;
}

const BranchCreationWizard: React.FC<BranchCreationWizardProps> = ({
  repositories,
  getBranchesForRepo,
  getDefaultBranchForRepo,
  createAndPushBranch,
  onClose,
  onComplete,
}) => {
  const [step, setStep] = useState<WizardStep>(repositories.length > 1 ? "SELECT_PROJECT" : "SELECT_BRANCH");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(repositories.length === 1 ? 0 : 0);
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string>("");
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0);
  const [branchName, setBranchName] = useState("");
  const [existingSuffix, setExistingSuffix] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; finalName: string; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadBranches = useCallback(
    async (repoIndex: number) => {
      setLoading(true);
      try {
        const branchList = await getBranchesForRepo(repoIndex);
        const defaultBr = getDefaultBranchForRepo(repoIndex);
        setBranches(branchList);
        setDefaultBranch(defaultBr);
        const defaultIndex = branchList.indexOf(defaultBr);
        setSelectedBranchIndex(defaultIndex >= 0 ? defaultIndex : 0);
      } catch {
        setBranches([]);
      }
      setLoading(false);
    },
    [getBranchesForRepo, getDefaultBranchForRepo],
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
    if (step === "SELECT_BRANCH" && branches.length === 0 && !loading) {
      loadBranches(selectedProjectIndex);
    }
  }, [step, selectedProjectIndex, branches.length, loading, loadBranches]);

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
    const baseBranch = branches[selectedBranchIndex];
    const createResult = await createAndPushBranch(selectedProjectIndex, baseBranch, trimmedName);
    setResult(createResult);
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
          setStep("SELECT_PROJECT");
        } else {
          onClose();
        }
      } else if (step === "ENTER_NAME") {
        setBranchName("");
        setExistingSuffix(null);
        setStep("SELECT_BRANCH");
      } else if (step === "RESULT") {
        const context =
          result?.success
            ? {
                repoIndex: selectedProjectIndex,
                baseBranch: branches[selectedBranchIndex],
                newBranch: result.finalName,
              }
            : undefined;
        onComplete(result?.success ?? false, context);
      }
      return;
    }

    if (step === "SELECT_PROJECT") {
      if (key.upArrow) {
        setSelectedProjectIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedProjectIndex((prev) => Math.min(repositories.length - 1, prev + 1));
      } else if (key.return) {
        loadBranches(selectedProjectIndex);
        setStep("SELECT_BRANCH");
      }
    } else if (step === "SELECT_BRANCH") {
      if (key.upArrow) {
        setSelectedBranchIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedBranchIndex((prev) => Math.min(branches.length - 1, prev + 1));
      } else if (key.return && branches.length > 0) {
        setStep("ENTER_NAME");
      }
    } else if (step === "ENTER_NAME") {
      if (key.return && branchName.trim()) {
        void handleCreateBranch();
      } else if (key.backspace || key.delete) {
        setBranchName((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        const validChar = /^[a-zA-Z0-9/_-]$/.test(input);
        if (validChar) {
          setBranchName((prev) => prev + input);
        }
      }
    } else if (step === "RESULT") {
      const context =
        result?.success
          ? {
              repoIndex: selectedProjectIndex,
              baseBranch: branches[selectedBranchIndex],
              newBranch: result.finalName,
            }
          : undefined;
      onComplete(result?.success ?? false, context);
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

  const renderProjectSelection = () => (
    <Box flexDirection="column" gap={1}>
      <Text>Select repository:</Text>
      <Box flexDirection="column">
        {repositories.map((repo, idx) => (
          <Box key={repo.index}>
            <Text color={idx === selectedProjectIndex ? "cyan" : undefined}>
              {idx === selectedProjectIndex ? "> " : "  "}
              {repo.name}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );

  const renderBranchSelection = () => {
    if (loading) {
      return <Text color="yellow">Loading branches...</Text>;
    }

    if (branches.length === 0) {
      return <Text color="red">No branches found</Text>;
    }

    const visibleCount = 8;
    const halfVisible = Math.floor(visibleCount / 2);
    let startIdx = Math.max(0, selectedBranchIndex - halfVisible);
    const endIdx = Math.min(branches.length, startIdx + visibleCount);
    if (endIdx - startIdx < visibleCount) {
      startIdx = Math.max(0, endIdx - visibleCount);
    }

    const visibleBranches = branches.slice(startIdx, endIdx);

    return (
      <Box flexDirection="column" gap={1}>
        <Text>Select base branch:</Text>
        <Box flexDirection="column">
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
          {endIdx < branches.length && <Text dimColor>  ...</Text>}
        </Box>
      </Box>
    );
  };

  const renderNameInput = () => {
    const baseBranch = branches[selectedBranchIndex] || "";
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
            From: <Text color="cyan">{branches[selectedBranchIndex]}</Text>
          </Text>
          <Text dimColor>Syncing now to create the worktree...</Text>
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
      return <Text dimColor>Press any key to continue</Text>;
    }
    if (step === "ENTER_NAME") {
      return <Text dimColor>Enter to create • ESC to go back</Text>;
    }
    return <Text dimColor>↑/↓ to navigate • Enter to select • ESC to cancel</Text>;
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
              Repository: <Text color="cyan">{repositories[selectedProjectIndex].name}</Text>
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
