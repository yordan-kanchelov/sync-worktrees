export function isValidGitBranchName(name: string): { valid: boolean; error?: string } {
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
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) {
    return { valid: false, error: "Branch name contains invalid characters" };
  }
  return { valid: true };
}
