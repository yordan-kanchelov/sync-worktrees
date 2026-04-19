export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp("^" + escapedPattern + "$");
    return regex.test(name);
  }
  return name === pattern;
}

export function filterBranchesByName(branches: string[], include?: string[], exclude?: string[]): string[] {
  let result = branches;

  if (include && include.length > 0) {
    result = result.filter((branch) => include.some((pattern) => matchesPattern(branch, pattern)));
  }

  if (exclude && exclude.length > 0) {
    result = result.filter((branch) => !exclude.some((pattern) => matchesPattern(branch, pattern)));
  }

  return result;
}
