export function isValidGitBranchName(name: string): { valid: boolean; error?: string } {
  if (!name.trim()) {
    return { valid: false, error: "Branch name cannot be empty" };
  }
  if (name === "@") {
    return { valid: false, error: "Branch name cannot be '@'" };
  }
  if (name.startsWith("-")) {
    return { valid: false, error: "Branch name cannot start with '-'" };
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return { valid: false, error: "Branch name cannot start or end with '/'" };
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
  if (name.includes("/.") || name.includes("./")) {
    return { valid: false, error: "Branch name cannot contain '/.' or './'" };
  }
  if (name.startsWith(".") || name.endsWith(".")) {
    return { valid: false, error: "Branch name cannot start or end with '.'" };
  }
  if (name.includes("//")) {
    return { valid: false, error: "Branch name cannot contain consecutive slashes" };
  }
  for (const component of name.split("/")) {
    if (component === "") {
      return { valid: false, error: "Branch name cannot contain empty path components" };
    }
    if (component.startsWith(".") || component.endsWith(".")) {
      return { valid: false, error: "Branch name path components cannot start or end with '.'" };
    }
    if (component.endsWith(".lock")) {
      return { valid: false, error: "Branch name path components cannot end with '.lock'" };
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    return { valid: false, error: "Branch name contains invalid characters" };
  }
  return { valid: true };
}
