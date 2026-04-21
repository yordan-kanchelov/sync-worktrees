/**
 * Escapes a value for POSIX shell single-quoted contexts only.
 */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
