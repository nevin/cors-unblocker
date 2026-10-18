import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const target = process.argv[2];
const release = process.argv.includes('--release');

if (!['chrome', 'firefox'].includes(target)) {
  throw new Error('Usage: node scripts/build.mjs <chrome|firefox> [--release]');
}

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outputDirectory = join(root, release ? 'release-dist' : 'dist', target);
const backgroundEntry = target === 'chrome' ? 'src/background/chrome.ts' : 'src/background/firefox.ts';

await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [
    join(root, backgroundEntry),
    join(root, 'src/popup/popup.ts'),
    join(root, 'src/options/options.ts'),
    join(root, 'src/devtools/devtools.ts'),
    join(root, 'src/devtools/panel.ts')
  ],
  bundle: true,
  format: target === 'chrome' ? 'esm' : 'iife',
  target: 'es2022',
  outbase: join(root, 'src'),
  outdir: outputDirectory,
  sourcemap: false,
  minify: release,
  minifyIdentifiers: release,
  minifySyntax: release,
  minifyWhitespace: release,
  drop: release ? ['debugger'] : []
});

async function copyCss(source, destination) {
  if (!release) {
    await cp(source, destination);
    return;
  }
  const { code } = await transform(await readFile(source, 'utf8'), { loader: 'css', minify: true });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, code);
}

await cp(join(root, 'src/popup/index.html'), join(outputDirectory, 'popup/index.html'));
await copyCss(join(root, 'src/popup/popup.css'), join(outputDirectory, 'popup/popup.css'));
await copyCss(join(root, 'src/shared/shared.css'), join(outputDirectory, 'popup/shared.css'));
await cp(join(root, 'src/options/index.html'), join(outputDirectory, 'options/index.html'));
await copyCss(join(root, 'src/options/options.css'), join(outputDirectory, 'options/options.css'));
await copyCss(join(root, 'src/shared/shared.css'), join(outputDirectory, 'options/shared.css'));
await cp(join(root, 'src/devtools/devtools.html'), join(outputDirectory, 'devtools/devtools.html'));
await cp(join(root, 'src/devtools/panel.html'), join(outputDirectory, 'devtools/panel.html'));
await copyCss(join(root, 'src/devtools/panel.css'), join(outputDirectory, 'devtools/panel.css'));
await copyCss(join(root, 'src/shared/shared.css'), join(outputDirectory, 'devtools/shared.css'));
await mkdir(join(outputDirectory, 'assets'), { recursive: true });
await copyFile(join(root, 'assets/icon.svg'), join(outputDirectory, 'assets/icon.svg'));
for (const size of [16, 32, 48, 128]) {
  await copyFile(join(root, `assets/icon-${size}.png`), join(outputDirectory, `assets/icon-${size}.png`));
}

const manifest = JSON.parse(await readFile(join(root, `manifest.${target}.json`), 'utf8'));
manifest.version = packageJson.version;
await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

