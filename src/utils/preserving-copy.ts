import * as fs from "fs/promises";

import type { CopyOptions } from "fs";

/**
 * Copies a directory tree whose source is deleted on the next step, on the
 * two paths where a rename is unavailable: preserving a diverged worktree
 * under `.diverged/` across devices, and restoring a trash payload onto a
 * fresh worktree when the trash root turns out not to share a filesystem with
 * it. Both exist to keep a user's only remaining copy of their files, so the
 * copy has to be faithful, not merely readable.
 *
 * `fs.cp` resolves every relative symlink target against the source directory
 * and writes the destination link as an absolute path back into the source, so
 * `node_modules/.bin/tsc -> ../typescript/bin/tsc` is copied as
 * `/old/worktree/node_modules/typescript/bin/tsc`. That is invisible while the
 * source is still there and fatal once it is gone — which is the whole point
 * of these two copies. Links are a small share of a dependency tree's files
 * (1278 of 20110 in this repository's own `node_modules`) but they are the
 * load-bearing share: 24 of its 30 top-level entries are links into the pnpm
 * store, so breaking them stops the tree resolving at all. A repository that
 * commits symlinks gets them back as `git status` modifications.
 *
 * `verbatimSymlinks: true` copies link targets byte for byte, matching what
 * the `fs.rename` each of these copies stands in for would have left — for
 * symlinks, contents, permissions and directory structure. Hard links are the
 * exception `fs.cp` cannot carry either way: a linked pair arrives as two
 * separate files, before this change and after it. Passing `dereference: true`
 * alongside is rejected by Node (`ERR_INCOMPATIBLE_OPTION_PAIR`); `false` is
 * accepted but is the default, so neither caller passes it. Dereferencing is
 * not wanted here anyway — replacing links with copies of their targets would
 * multiply the size of the preserved tree and destroy the fact that they were
 * links. Nothing about non-symlink content changes.
 *
 * An absolute symlink pointing inside the source tree is preserved as-is and
 * so still dangles afterwards. That is deliberate: a rename leaves it dangling
 * too, and rewriting it here would make the fallback behave differently from
 * the fast path it substitutes for. The same reasoning covers a relative link
 * whose target escapes the tree being copied: `.diverged/<name>/` sits one
 * directory deeper than the worktree did, so `../../shared/thing` resolves
 * somewhere else after the move and dangles. The old code happened to keep
 * such a link working by rewriting it to an absolute path — but only in the
 * cross-device branch, so the same worktree came out differently depending on
 * which filesystem it landed on. Matching the rename is the property worth
 * having.
 */
export async function copyTreePreservingSymlinks(
  source: string,
  destination: string,
  options: Pick<CopyOptions, "force" | "filter"> = {},
): Promise<void> {
  await fs.cp(source, destination, { ...options, recursive: true, verbatimSymlinks: true });
}
