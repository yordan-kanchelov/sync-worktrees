export function sanitizePastedFilter(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}
