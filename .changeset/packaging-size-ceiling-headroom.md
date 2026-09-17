---
"sync-worktrees": patch
---

Tooling only: `pnpm smoke`'s unpacked-tarball ceiling moves from 1,250,000 to 1,400,000 bytes. The published bundles are not minified, so every comment in the source ships with them and ordinary work on this codebase walks the tarball up by single-digit kB at a time; the old ceiling had been reached that way and was refusing changes of a few kB, which is not what it is for. It still trips on the step changes it was written for — a dependency that stops being `external` in esbuild, or source maps coming back, each of which adds hundreds of kB at once — and the file-count ceiling is unchanged. The script now carries the current composition of the tarball next to the limits.
