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
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#070910"/>
      <stop offset="56%" stop-color="#0e1119"/>
      <stop offset="100%" stop-color="#143b99"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4d97ff"/>
      <stop offset="100%" stop-color="#22c55e"/>
    </linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#94a3b8" stroke-opacity="0.10" stroke-width="1"/>
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#grid)"/>
  <rect x="72" y="72" width="1056" height="486" rx="32" fill="#0e1119" fill-opacity="0.76" stroke="#383f54" filter="url(#shadow)"/>

  <g transform="translate(112 112)">
    <rect x="0" y="0" width="74" height="74" rx="18" fill="url(#accent)"/>
    <path d="M24 18v24" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <circle cx="24" cy="50" r="8" fill="none" stroke="#ffffff" stroke-width="5"/>
    <circle cx="52" cy="24" r="8" fill="none" stroke="#ffffff" stroke-width="5"/>
    <path d="M52 32c0 13-8 22-20 25" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <text x="96" y="47" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700" fill="#f8fafc">sync-worktrees</text>
    <text x="96" y="76" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="600" letter-spacing="1.8" fill="#85bcff">WORKSPACES FOR HUMANS AND AI AGENTS</text>
  </g>

  <text x="112" y="290" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="800" fill="#ffffff">Keep every branch</text>
  <text x="112" y="374" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="800" fill="#ffffff">checked out.</text>
  <text x="112" y="440" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="500" fill="#cbd5e1">Predictable Git worktrees, synced repos, and MCP tools</text>
  <text x="112" y="482" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="500" fill="#cbd5e1">for Claude Code, Cursor, Codex, and more.</text>

  <g transform="translate(770 338)">
    <rect x="0" y="0" width="306" height="112" rx="18" fill="#070910" stroke="#383f54"/>
    <text x="28" y="45" font-family="'JetBrains Mono', 'SFMono-Regular', Consolas, monospace" font-size="20" fill="#22c55e">$</text>
    <text x="52" y="45" font-family="'JetBrains Mono', 'SFMono-Regular', Consolas, monospace" font-size="20" fill="#e2e8f0">sync-worktrees</text>
    <text x="28" y="80" font-family="'JetBrains Mono', 'SFMono-Regular', Consolas, monospace" font-size="18" fill="#85bcff">detect_context</text>
    <text x="184" y="80" font-family="'JetBrains Mono', 'SFMono-Regular', Consolas, monospace" font-size="18" fill="#94a3b8">ready</text>
  </g>
</svg>`;

await mkdir(publicDir, { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(outPath);

console.log(`generated ${outPath}`);
