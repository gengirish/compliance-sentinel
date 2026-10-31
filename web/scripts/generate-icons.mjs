// Renders the placeholder app icons (lucide ShieldCheck on the brand gradient) to PNG.
// Run with `pnpm icons` from web/. Swap the SVG for real artwork later.
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// sharp is not a direct dependency: pnpm installs it only as next's optional dependency,
// so resolve it from next's location instead of web/node_modules.
const requireFromRoot = createRequire(path.join(root, "package.json"));
const requireFromNext = createRequire(requireFromRoot.resolve("next/package.json"));
const sharp = requireFromNext("sharp");

const BG = "#0A0F1C";
const SHIELD =
  "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";
const CHECK = "m9 12 2 2 4-4";

/**
 * Builds the icon SVG on a size x size canvas.
 * @param {number} size canvas size in px
 * @param {object} opts
 * @param {boolean} opts.fullBleed fill the whole canvas with the background (maskable, apple)
 * @param {number} opts.tile tile size as a fraction of the canvas
 */
function svg(size, { fullBleed, tile }) {
  const tileSize = size * tile;
  const tileOffset = (size - tileSize) / 2;
  const tileRadius = tileSize * 0.24;
  const glyphSize = tileSize * 0.62;
  const glyphOffset = (size - glyphSize) / 2;
  const scale = glyphSize / 24;
  const bg = fullBleed
    ? `<rect width="${size}" height="${size}" fill="${BG}"/>`
    : `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${BG}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <!-- 135deg: top-left to bottom-right -->
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C3AED"/>
      <stop offset="0.55" stop-color="#A78BFA"/>
      <stop offset="1" stop-color="#06B6D4"/>
    </linearGradient>
  </defs>
  ${bg}
  <rect x="${tileOffset}" y="${tileOffset}" width="${tileSize}" height="${tileSize}" rx="${tileRadius}" fill="url(#g)"/>
  <g transform="translate(${glyphOffset} ${glyphOffset}) scale(${scale})" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="${SHIELD}"/>
    <path d="${CHECK}"/>
  </g>
</svg>`;
}

const outputs = [
  // "any" purpose: rounded dark tile, transparent corners
  { file: "public/icons/icon-192.png", size: 192, fullBleed: false, tile: 0.72 },
  { file: "public/icons/icon-512.png", size: 512, fullBleed: false, tile: 0.72 },
  // maskable: full-bleed background, artwork well inside the central 80% safe zone
  { file: "public/icons/icon-maskable-512.png", size: 512, fullBleed: true, tile: 0.56 },
  { file: "src/app/icon.png", size: 512, fullBleed: false, tile: 0.72 },
  // apple: no transparency, iOS applies its own corner mask
  { file: "src/app/apple-icon.png", size: 180, fullBleed: true, tile: 0.72, flatten: true },
];

for (const { file, size, flatten, ...opts } of outputs) {
  const out = path.join(root, file);
  await mkdir(path.dirname(out), { recursive: true });
  let img = sharp(Buffer.from(svg(size, opts)), { density: 72 }).resize(size, size);
  if (flatten) img = img.flatten({ background: BG }).removeAlpha();
  await img.png({ compressionLevel: 9 }).toFile(out);
  console.log(`wrote ${file} (${size}x${size})`);
}
