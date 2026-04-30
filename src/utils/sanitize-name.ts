import { ConfigValidationError } from "../errors";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
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
  cleaned = cleaned.replace(/[. ]+$/, "");

  if (cleaned.length === 0) {
    throw new ConfigValidationError(fieldContext, `'${name}' produces an empty path segment after sanitization`);
  }

  if (WINDOWS_RESERVED.test(cleaned)) {
    throw new ConfigValidationError(fieldContext, `'${cleaned}' is a reserved name on Windows`);
  }

  return cleaned;
}
