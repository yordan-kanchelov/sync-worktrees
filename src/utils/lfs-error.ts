/**
 * Extracts error message from unknown error type
 * @param error The error to extract message from
 * @returns The error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Common LFS error patterns that indicate Git LFS-related failures
 */
export const LFS_ERROR_PATTERNS = Object.freeze([
  "smudge filter lfs failed",
  "Object does not exist on the server",
  "external filter 'git-lfs filter-process' failed",
] as const);

/**
 * Checks if an error message contains any known LFS error patterns
 * @param errorMessage The error message to check
 * @returns true if the error is related to Git LFS
 */
export function isLfsError(errorMessage: string): boolean {
  return LFS_ERROR_PATTERNS.some((pattern) => errorMessage.includes(pattern));
}

/**
 * Checks if an error object contains any known LFS error patterns
 * @param error The error object to check
 * @returns true if the error is related to Git LFS
 */
export function isLfsErrorFromError(error: unknown): boolean {
  return isLfsError(getErrorMessage(error));
}
