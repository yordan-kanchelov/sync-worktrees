import { redactSecretsInText } from "./git-url";

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function configLoadErrorMessage(error: unknown): string {
  return redactSecretsInText(getErrorMessage(error).replace(/^Failed to load config file: /, ""));
}
