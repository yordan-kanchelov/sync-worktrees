import { ConfigValidationError } from "../errors";

// eslint-disable-next-line no-control-regex -- Windows reserves \x00–\x1f for path validation; intentional
const ILLEGAL_CHARS = /[<>:"|?*\x00-\x1f]/g;

export function sanitizeNameForPath(name: string, fieldContext = "name"): string {
  if (!name || typeof name !== "string") {
    throw new ConfigValidationError(fieldContext, "must be a non-empty string");
  }

  let cleaned = name.trim();
  cleaned = cleaned.replace(/[/\\]/g, "-");
  cleaned = cleaned.replace(/^\.+/, "");
  cleaned = cleaned.replace(ILLEGAL_CHARS, "_");
  let end = cleaned.length;
  while (end > 0 && (cleaned[end - 1] === "." || cleaned[end - 1] === " ")) end--;
  cleaned = cleaned.slice(0, end);

  if (cleaned.length === 0) {
    throw new ConfigValidationError(fieldContext, `'${name}' produces an empty path segment after sanitization`);
  }

  return cleaned;
}
