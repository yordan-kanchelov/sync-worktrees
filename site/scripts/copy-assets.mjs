import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const repoRoot = resolve(siteRoot, "..");

const tasks = [
  {
    src: resolve(repoRoot, "assets/sync-worktrees-demo-optimized.gif"),
    dest: resolve(siteRoot, "public/demo.gif"),
  },
];

await mkdir(resolve(siteRoot, "public"), { recursive: true });

for (const { src, dest } of tasks) {
  try {
    await copyFile(src, dest);
    console.log(`copied ${src} -> ${dest}`);
  } catch (err) {
    console.warn(`skipped ${src}: ${err.message}`);
  }
}
