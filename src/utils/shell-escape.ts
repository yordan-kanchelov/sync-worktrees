/**
 * Escapes a value for POSIX shell single-quoted contexts only.
 *
 * Unsafe for cmd.exe or PowerShell command strings on Windows. Prefer argv-based
 * child_process APIs (spawn without { shell: true }) when passing user-controlled values.
 */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
