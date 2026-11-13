/** Normalises pasted text for a one-line filter: line breaks become spaces, ends are trimmed. */
export function sanitizePastedFilter(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}
