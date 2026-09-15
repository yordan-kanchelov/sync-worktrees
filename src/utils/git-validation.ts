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

// The bound {@link isValidGitBranchName} does not give: "is this a name `git
// branch` itself would accept?". A branch name read back out of a trash
// manifest needs that one and not the stricter one — every branch git was ever
// able to create has to stay restorable, and a check stricter than git's
// silently strands a real entry as unrecognized content — while a name a user
// asks this tool to create keeps the stricter bound above.
//
// This deliberately does NOT delegate to the validator above. Doing so can only
// ever produce a superset of its strictness, which is the wrong direction here:
// that validator rejects any component ending in a dot (`./` anywhere), and git
// accepts those. `v1./x`, `a./b` and `release-1.0./rc` are all names `git branch`
// creates and `git check-ref-format --branch` approves, and a repository can
// carry them in from a remote without this tool ever validating them — so
// refusing them here would make their trash entries permanently unlistable,
// unrestorable and, because the reaper skips what it cannot parse, unreapable.
//
// The rules below are git's own `check_refname_format` for a branch shorthand,
// plus the one extra `git branch` enforces (a leading dash). Note what git does
// NOT forbid: a dot ending a non-final component, or a dot anywhere inside one.
// Only a component STARTING with a dot, and the whole name ENDING in one, are
// out. Verified against `git check-ref-format --branch` on git 2.43.0.
//
// `HEAD` is the one name left deliberately looser than `git branch`, which
// refuses it: erring wide costs a clearer error from git itself, erring narrow
// costs an entry. `@` is accepted, matching git.
export function isGitCreatableBranchName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  // `git branch` refuses a leading dash; check_refname_format does not, so a
  // remote really can carry `refs/heads/-foo` and a manifest really can record
  // it. It still must never reach git as a positional argument.
  if (name.startsWith("-")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  for (const component of name.split("/")) {
    if (component.length === 0) return false;
    if (component.startsWith(".")) return false;
    if (component.endsWith(".lock")) return false;
  }
  return true;
}

// Hex only, so an object id read back out of a manifest can never be mistaken
// for an option by a git command that takes it positionally. `git branch
// <name> -m` is not an error — git's option parser permutes it into
// `git branch -m <name>` and renames a branch.
//
// Deliberately not pinned to exactly 40 or 64 characters: this tool only ever
// stores full `rev-parse` output, so nothing it writes is near the bound, and
// a narrower rule would turn manifests written under some future hash into
// unrecognized content that is never listed, restored or reaped.
export function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(value);
}
