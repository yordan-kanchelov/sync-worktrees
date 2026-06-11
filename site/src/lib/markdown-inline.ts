function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a single line of inline markdown (only `backtick` code) to styled HTML.
 * Used via `set:html` for short bullets/copy where a full markdown processor
 * (which wraps output in <p> and runs async) would be overkill.
 */
export function inlineCodeToHtml(s: string): string {
  return escapeHtml(s).replace(
    /`([^`]+)`/g,
    '<code class="whitespace-nowrap font-mono text-sm bg-ink-50 px-1.5 py-0.5 rounded">$1</code>',
  );
}

/** Flatten inline markdown to plain text — for FAQ JSON-LD and llms plain sections. */
export function mdToPlainText(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
