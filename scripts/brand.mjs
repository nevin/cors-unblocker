// Generates every logo, icon and store image from the vector sources below.
// Usage: node scripts/brand.mjs   (renders PNGs with Playwright's Chromium)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(root, 'assets/brand');

const NAVY = '#0B2C5F';
const ORANGE = '#FF6B00';
const GRAY = '#3A3D42';

// ---------------------------------------------------------------------------
// Wordmark geometry, drawn on the reference artwork's grid (cap height 325).
// The letters are split by a horizontal channel the arrow travels through.
// ---------------------------------------------------------------------------
const CORS = [
  // C — continuous, the inner chevron points at the arrow's tail
  'M270 248H505L405 341H300L222 415L290 485H395L485 573H265L152 465V360Z',
  // O — top and bottom halves
  'M460 382V325Q460 315 468 307L520 255Q527 248 540 248H725Q745 248 760 265L795 305Q805 316 805 330V382H720V355Q720 330 695 330H575Q548 330 548 355V382Z',
  'M460 450V500Q460 530 488 550L512 573H725Q752 573 775 550L805 520V450H720V465Q720 490 695 490H575Q548 490 548 465V450Z',
  // R — bowl on top, leg below
  'M780 248H1000Q1040 248 1062 285L1074 305Q1088 330 1088 355V382H1003Q1012 355 1002 345Q992 332 970 332H850Z',
  'M835 450H1057Q1030 485 990 483L1065 573H940Z',
  // S — top arm and bottom arm
  'M1195 248H1450L1365 330H1250Q1210 330 1213 360Q1215 375 1228 382H1115V340Q1115 325 1130 310Z',
  'M1310 450H1418Q1422 460 1422 480V505L1335 573H1085L1170 490H1290Q1320 490 1322 470Q1323 458 1310 450Z',
];
const ARROW = 'M240 415L262 395H1458L1448 341L1568 415L1448 490L1458 435H262Z';

// UNBLOCKER — monoline letters, stroke-width 18, cap 612–680.
const UNBLOCKER = [
  'M169 612V650Q169 671 190 671H218Q239 671 239 650V612', // U
  'M337 680V612M407 612V680', // N stems
  'M337 621L407 671', // N diagonal
  'M506 680V621H562Q575 621 575 633.5Q575 646 562 646H506M506 646H566Q579 646 579 658.5Q579 671 566 671H497', // B
  'M666 612V671H727', // L
  'M817 621H862Q874 621 874 633V659Q874 671 862 671H817Q805 671 805 659V633Q805 621 817 621Z', // O
  'M1027 621H973Q961 621 961 633V659Q961 671 973 671H1027', // C
  'M1107 612V680M1107 646H1135L1186 612M1135 646L1186 680', // K
  'M1338 621H1283Q1271 621 1271 633V659Q1271 671 1283 671H1338M1271 646H1332', // E
  'M1423 680V621H1490Q1501 621 1501 633.5Q1501 646 1490 646H1423M1472 646L1505 680', // R
];

function wordmark({ letters = NAVY, arrow = ORANGE, tagline = GRAY } = {}) {
  return `<g fill="${letters}">${CORS.map((d) => `<path d="${d}"/>`).join('')}</g>
  <path d="${ARROW}" fill="${arrow}"/>
  <g fill="none" stroke="${tagline}" stroke-width="18" stroke-linejoin="round" clip-path="url(#cap)">${UNBLOCKER.map((d) => `<path d="${d}"/>`).join('')}</g>`;
}

const svg = (viewBox, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="CORS Unblocker">
  <title>CORS Unblocker</title>
  <defs><clipPath id="cap"><rect x="0" y="612" width="2000" height="68"/></clipPath>${defs}</defs>
  ${body}
</svg>
`;

// ---------------------------------------------------------------------------
// Symbol: the logo's chevron C with the arrow passing through it.
// ---------------------------------------------------------------------------
const SYMBOL_C = 'M46 28H96L80 46H54L40 64L54 82H80L96 100H46L22 76V52Z';
const SYMBOL_ARROW = 'M44 64L49 59H96L94 50L112 64L94 78L96 69H49Z';
// Hand-tuned for 16px so the strokes land on whole pixels.
const SMALL_C = 'M5 1.5H12.5L10.5 4H6.5L4 8L6.5 12H10.5L12.5 14.5H5L1.5 11V5Z';
const SMALL_ARROW = 'M6 8L7 7H11V5L15 8L11 11V9H7Z';

const VARIANTS = {
  light: { letters: NAVY, arrow: ORANGE, tagline: GRAY },
  dark: { letters: '#FFFFFF', arrow: ORANGE, tagline: '#C5CCD6' },
  black: { letters: '#000000', arrow: '#000000', tagline: '#000000' },
  white: { letters: '#FFFFFF', arrow: '#FFFFFF', tagline: '#FFFFFF' },
};

const tileBody = (small) =>
  small
    ? `<rect width="16" height="16" rx="3.5" fill="${NAVY}"/><path d="${SMALL_C}" fill="#FFFFFF"/><path d="${SMALL_ARROW}" fill="${ORANGE}"/>`
    : `<rect x="4" y="4" width="120" height="120" rx="26" fill="${NAVY}"/><g transform="translate(-3 0)"><path d="${SYMBOL_C}" fill="#FFFFFF"/><path d="${SYMBOL_ARROW}" fill="${ORANGE}"/></g>`;

const iconTile = (small) => svg(small ? '0 0 16 16' : '0 0 128 128', tileBody(small));

const symbol = ({ letters, arrow }) =>
  svg('18 24 98 80', `<path d="${SYMBOL_C}" fill="${letters}"/><path d="${SYMBOL_ARROW}" fill="${arrow}"/>`);

const logo = (colors) => svg('112 208 1496 512', wordmark(colors));

// Tile + wordmark side by side, for headers and README banners.
const logoHorizontal = (colors) =>
  svg('0 0 2060 512', `<g transform="translate(16 16) scale(3.75)">${tileBody(false)}</g><g transform="translate(540 0)"><g transform="translate(-112 -208)">${wordmark(colors)}</g></g>`);

// ---------------------------------------------------------------------------
// Store promo tiles (Chrome Web Store, Edge Add-ons): logo on brand colours.
// ---------------------------------------------------------------------------
const promo = (w, h, withTagline) => {
  const logoW = w * (withTagline ? 0.62 : 0.78);
  const s = logoW / 1496;
  const x = (w - logoW) / 2;
  const y = (h - 512 * s) / 2 - (withTagline ? h * 0.07 : 0);
  const line = withTagline
    ? `<text x="${w / 2}" y="${y + 512 * s + h * 0.13}" text-anchor="middle" font-family="-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${h * 0.055}" font-weight="500" fill="#C5CCD6">Find, explain and fix blocked CORS calls while you develop</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  <defs><clipPath id="cap"><rect x="0" y="612" width="2000" height="68"/></clipPath>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E3672"/><stop offset="1" stop-color="#081F45"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <g transform="translate(${x} ${y}) scale(${s}) translate(-112 -208)">${wordmark(VARIANTS.dark)}</g>
  ${line}
</svg>
`;
};

// Store listing icon: 96px artwork centred in 128px with transparent padding.
const storeIcon = () => svg('-16 -16 160 160', tileBody(false));

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const files = {
  'assets/icon.svg': iconTile(false),
  'assets/icon-16.svg': iconTile(true),
  'assets/brand/icon-tile.svg': iconTile(false),
  'assets/brand/icon-tile-small.svg': iconTile(true),
};
for (const [name, colors] of Object.entries(VARIANTS)) {
  files[`assets/brand/logo-${name}.svg`] = logo(colors);
  files[`assets/brand/logo-horizontal-${name}.svg`] = logoHorizontal(colors);
  files[`assets/brand/symbol-${name}.svg`] = symbol(colors);
}

const renders = [
  // Extension icons: Chrome/Edge/Opera use 16/32/48/128, Firefox also picks 64/96.
  ...[16, 32, 48, 64, 96, 128].map((size) => ({ src: size <= 16 ? 'assets/icon-16.svg' : 'assets/icon.svg', out: `assets/icon-${size}.png`, w: size, h: size })),
  { src: 'assets/brand/icon-tile.svg', out: 'assets/brand/png/icon-tile-512.png', w: 512, h: 512 },
  ...Object.keys(VARIANTS).flatMap((name) => [
    { src: `assets/brand/logo-${name}.svg`, out: `assets/brand/png/logo-${name}-1200.png`, w: 1200, h: Math.round((1200 * 512) / 1496) },
    { src: `assets/brand/logo-horizontal-${name}.svg`, out: `assets/brand/png/logo-horizontal-${name}-1200.png`, w: 1200, h: Math.round((1200 * 512) / 2060) },
    { src: `assets/brand/symbol-${name}.svg`, out: `assets/brand/png/symbol-${name}-512.png`, w: 512, h: Math.round((512 * 80) / 98) },
  ]),
  { svg: storeIcon(), out: 'assets/store/store-icon-128.png', w: 128, h: 128 },
  { svg: storeIcon(), out: 'assets/store/edge-logo-300.png', w: 300, h: 300 },
  { svg: promo(440, 280, false), out: 'assets/store/promo-small-440x280.png', w: 440, h: 280, opaque: true },
  { svg: promo(1400, 560, true), out: 'assets/store/promo-marquee-1400x560.png', w: 1400, h: 560, opaque: true },
  { svg: logoHorizontal(VARIANTS.light).replace('<title>', '<rect x="-150" y="-331" width="2360" height="1180" fill="#FFFFFF"/><title>').replace('0 0 2060 512', '-150 -334 2360 1180'), out: 'assets/store/social-preview-1280x640.png', w: 1280, h: 640, opaque: true },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const { readFile } = await import('node:fs/promises');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const r of renders) {
    const source = r.svg ?? (await readFile(join(root, r.src), 'utf8'));
    await page.setViewportSize({ width: r.w, height: r.h });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${r.w}px;height:${r.h}px}</style>${source}`);
    await mkdir(dirname(join(root, r.out)), { recursive: true });
    await page.screenshot({ path: join(root, r.out), omitBackground: !r.opaque });
  }
  await browser.close();
  console.log(`Wrote ${Object.keys(files).length} SVGs and ${renders.length} PNGs`);
}
