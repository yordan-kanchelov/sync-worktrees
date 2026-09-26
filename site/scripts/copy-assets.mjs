import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const repoRoot = resolve(siteRoot, "..");

// The hero video and its poster frame, rendered by demo/render.sh into the repo's assets/, and the launch video with
// its poster, rendered by demo/launch/render.sh.
const tasks = [
  {
    src: resolve(repoRoot, "assets/demo.mp4"),
    dest: resolve(siteRoot, "public/demo.mp4"),
  },
  {
    src: resolve(repoRoot, "assets/demo-poster.webp"),
    dest: resolve(siteRoot, "public/demo-poster.webp"),
  },
  {
    src: resolve(repoRoot, "assets/launch.mp4"),
    dest: resolve(siteRoot, "public/launch.mp4"),
  },
  {
    src: resolve(repoRoot, "assets/launch-poster.jpg"),
    dest: resolve(siteRoot, "public/launch-poster.jpg"),
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
