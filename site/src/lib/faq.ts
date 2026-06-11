import { mdToPlainText } from "./markdown-inline";

/** "01-worktree-vs-sync" → "worktree-vs-sync" — keeps the file-ordering prefix out of URLs. */
export function faqSlug(id: string): string {
  return id.replace(/^\d+-/, "");
}

export function faqUrl(id: string): string {
  return `/faq/${faqSlug(id)}/`;
}

/** First ~160 chars of the answer as plain text, for meta descriptions. */
export function faqMetaDescription(body: string): string {
  const text = mdToPlainText(body);
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}
