import { redactSecretsInText } from "./git-url";

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
    return String(error.message);
  }
  return String(error);
}

/**
 * A config load failure for a one-line CLI report, redacted. The loader already
 * says "Failed to load config file: ..." for a file it could not evaluate; the
 * label a caller puts in front of it must not say so a second time.
 */
export function configLoadErrorMessage(error: unknown): string {
  return redactSecretsInText(getErrorMessage(error).replace(/^Failed to load config file: /, ""));
}
