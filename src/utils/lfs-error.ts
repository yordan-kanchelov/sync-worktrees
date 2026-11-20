import { getErrorMessage } from "./errors";

const LFS_ERROR_PATTERNS = Object.freeze([
  "smudge filter lfs failed",
  "Object does not exist on the server",
  "external filter 'git-lfs filter-process' failed",
] as const);

export function isLfsError(errorMessage: string): boolean {
  return LFS_ERROR_PATTERNS.some((pattern) => errorMessage.includes(pattern));
}

export function isLfsErrorFromError(error: unknown): boolean {
  return isLfsError(getErrorMessage(error));
}

export const MISSING_REMOTE_REF_PATTERNS = Object.freeze([
  "couldn't find remote ref",
  "Couldn't find remote ref",
  "not our ref",
] as const);

export function isMissingRemoteRefError(errorMessage: string): boolean {
  return MISSING_REMOTE_REF_PATTERNS.some((pattern) => errorMessage.includes(pattern));
}
