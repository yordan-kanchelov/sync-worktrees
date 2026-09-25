import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { isMouseSequence } from "../utils/mouse";
import { isListDown, isListUp, listRowsFor, listWindow, useModalLayout, wrappedRows } from "./layout";

import { isValidGitBranchName } from "../utils/git-validation";

type WizardStep = "SELECT_PROJECT" | "SELECT_BRANCH" | "ENTER_NAME" | "CREATING" | "RESULT";

// The one place the suffix is worked out. The name shown on the ENTER_NAME
// step and the name submitted to createAndPushBranch both come from here, so
// the wizard can never display `will create: <name>-1` and then ask for
// `<name>` — which is what sent the service at a branch that was already on
// the remote.
const resolveFreeBranchName = (name: string, taken: readonly string[]): string => {
  let suffix = 0;
  let candidate = name;
  while (taken.includes(candidate)) {
    suffix++;
    candidate = `${name}-${suffix}`;
  }
  return candidate;
};

export interface BranchCreationWizardProps {
  repositories: Array<{ index: number; name: string; repoUrl: string }>;
  getBranchesForRepo: (index: number) => Promise<string[]>;
  getDefaultBranchForRepo: (index: number) => Promise<string>;
  fetchForRepo?: (index: number) => Promise<void>;
  createAndPushBranch: (
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ) => Promise<{ success: boolean; finalName: string; error?: string }>;
  onClose: () => void;
  onComplete: (success: boolean) => void;
  onBranchCreated?: (context: { repoIndex: number; baseBranch: string; newBranch: string }) => void;
  /** Rows the wizard may use; defaults to the terminal height. */
  availableRows?: number;
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
  availableRows,
}) => {
  const layout = useModalLayout(60, availableRows);
  const [step, setStep] = useState<WizardStep>(repositories.length > 1 ? "SELECT_PROJECT" : "SELECT_BRANCH");
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0);
  const [selectedRepoIndex, setSelectedRepoIndex] = useState(repositories.length === 1 ? repositories[0].index : -1);
  const [projectFilter, setProjectFilter] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string>("");
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0);
  const [branchFilter, setBranchFilter] = useState("");
  const [branchName, setBranchName] = useState("");
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

        // The default branch only pre-selects and labels an entry; clone mode
        // resolves it from the remote when no branch is configured, and that
        // can fail. Losing the hint must not blank a branch list that loaded
        // fine — no marker beats a marker on the wrong branch.
        let defaultBr = "";
        try {
          defaultBr = await getDefaultBranchForRepo(repoIndex);
        } catch {
          defaultBr = "";
        }
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

  // The free name for what has been typed so far: derived on every render from
  // the same two inputs the display reads, never held in state that a
  // keystroke could leave a render behind.
  const plannedName = useMemo(() => resolveFreeBranchName(branchName.trim(), branches), [branchName, branches]);

  const validateBranchName = useCallback((name: string) => {
    if (!name.trim()) {
      setValidationError(null);
      return;
    }

    const validation = isValidGitBranchName(name);
    setValidationError(validation.valid ? null : (validation.error ?? null));
  }, []);

  useEffect(() => {
    if (step === "SELECT_BRANCH" && !branchesLoadedRef.current && !loading && selectedRepoIndex >= 0) {
      branchesLoadedRef.current = true;
      void loadBranches(selectedRepoIndex);
    }
  }, [step, selectedRepoIndex, loading, loadBranches]);

  useEffect(() => {
    if (step === "ENTER_NAME") {
      validateBranchName(branchName);
    }
  }, [branchName, step, validateBranchName]);

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
    // `plannedName`, not `trimmedName`: the name the step above displayed is
    // the name that gets created.
    const requestedName = plannedName;
    try {
      const createResult = await createAndPushBranch(selectedRepoIndex, baseBranch, requestedName);
      setResult(createResult);
      if (createResult.success && onBranchCreated) {
        onBranchCreated({
          repoIndex: selectedRepoIndex,
          baseBranch,
          newBranch: createResult.finalName,
        });
      }
    } catch (err) {
      setResult({
        success: false,
        finalName: requestedName,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setStep("RESULT");
    }
  };

  useInput((input, key) => {
    // Mouse reports arrive as a single `input` string; ignore them here so a
    // scroll never registers as a keystroke.
    if (isMouseSequence(input)) return;

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
        setStep("SELECT_BRANCH");
      } else if (step === "RESULT") {
        onComplete(result?.success ?? false);
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
          branchesLoadedRef.current = true;
          setIsFetching(false);
          void loadBranches(selectedRepo.index);
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
      if (isListUp(input, key)) {
        setSelectedBranchIndex((prev) => Math.max(0, prev - 1));
      } else if (isListDown(input, key)) {
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

  usePaste((text) => {
    if (step === "SELECT_PROJECT") {
      setProjectFilter((prev) => prev + text);
      setSelectedProjectIndex(0);
    } else if (step === "SELECT_BRANCH") {
      setBranchFilter((prev) => prev + text);
      setSelectedBranchIndex(0);
    } else if (step === "ENTER_NAME") {
      setBranchName((prev) => prev + text.replace(/[^a-zA-Z0-9/._-]/g, ""));
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

  // Rows the step's list may take: what the modal has, less its chrome, the
  // step's own lines above the list and a footer that wraps on a narrow box.
  const listRoom = (linesAboveList: number): number => {
    const footer = footerText();
    const footerExtra = footer ? wrappedRows(footer, layout.innerWidth) - 1 : 0;
    return layout.rows - layout.chromeRows - linesAboveList - footerExtra;
  };

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

  const renderBranchSelection = () => {
    if (loading) {
      return <Text color="yellow">Loading branches{isFetching ? " (fetching from remote...)" : "..."}</Text>;
    }

    if (branches.length === 0) {
      return <Text color="red">No branches found</Text>;
    }

    // "Select base branch:", the filter, the gaps after each, and the
    // repository line above them once there is more than one to choose.
    const linesAbove = 4 + (repositories.length > 1 ? 2 : 0);
    const visibleCount = listRowsFor(listRoom(linesAbove), filteredBranches.length);
    const { start: startIdx, end: endIdx } = listWindow(selectedBranchIndex, filteredBranches.length, visibleCount);

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
              {startIdx > 0 && <Text dimColor> ...</Text>}
              {visibleBranches.map((branch, idx) => {
                const actualIdx = startIdx + idx;
                const isSelected = actualIdx === selectedBranchIndex;
                const isDefault = branch === defaultBranch;
                return (
                  <Box key={branch}>
                    <Text color={isSelected ? "cyan" : undefined} wrap="truncate-end">
                      {isSelected ? "> " : "  "}
                      {branch}
                      {isDefault && <Text color="green"> (default)</Text>}
                    </Text>
                  </Box>
                );
              })}
              {endIdx < filteredBranches.length && <Text dimColor> ...</Text>}
            </>
          )}
        </Box>
      </Box>
    );
  };

  const renderNameInput = () => {
    const baseBranch = filteredBranches[selectedBranchIndex] || "";
    const collides = plannedName !== branchName.trim();
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
        {validationError && <Text color="red">{validationError}</Text>}
        {!validationError && endsWithSlash && (
          <Text color="yellow" dimColor>
            Hint: consecutive slashes (//) are not allowed
          </Text>
        )}
        {!validationError && !endsWithSlash && collides && branchName && (
          <Text color="yellow">
            Name exists, will create: <Text color="cyan">{plannedName}</Text>
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

  function footerText(): string | null {
    if (step === "CREATING") return null;
    if (step === "RESULT") {
      return "Press any key to close";
    }
    if (step === "ENTER_NAME") {
      return "Enter to create • ESC to go back";
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
