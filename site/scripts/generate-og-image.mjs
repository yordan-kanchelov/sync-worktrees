import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const publicDir = resolve(siteRoot, "public");
const outPath = resolve(publicDir, "og-image.png");

const width = 1200;
const height = 630;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#0e1119"/>
  <text x="80" y="120" font-family="Georgia, 'Times New Roman', serif" font-size="28" font-weight="600" fill="#aab1c2">sync-worktrees</text>
  <text x="80" y="250" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="700" fill="#f7f8fa">Keep every branch</text>
  <text x="80" y="328" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="700" fill="#f7f8fa">checked out.</text>
  <text x="80" y="400" font-family="Georgia, 'Times New Roman', serif" font-size="28" fill="#aab1c2">Switching is just cd. One config rebuilds the workspace.</text>
  <rect x="80" y="460" width="420" height="88" rx="8" fill="#070910" stroke="#383f54"/>
  <text x="104" y="514" font-family="'SFMono-Regular', Consolas, monospace" font-size="22" fill="#22c55e">$</text>
  <text x="128" y="514" font-family="'SFMono-Regular', Consolas, monospace" font-size="22" fill="#eceef3">sync-worktrees</text>
</svg>`;

await mkdir(publicDir, { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(outPath);

console.log(`generated ${outPath}`);
