import { access, readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

for (const target of ['chrome', 'firefox']) {
  const output = new URL(`../dist/${target}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', output), 'utf8'));

  if (manifest.version !== packageJson.version) {
    throw new Error(`${target} manifest version does not match package.json`);
  }

  for (const file of ['LICENSE', 'popup/index.html', 'popup/shared.css', 'options/index.html', 'options/shared.css', 'devtools/devtools.html', 'devtools/panel.html', 'devtools/panel.css', 'devtools/shared.css', 'assets/icon.svg', 'assets/brand/logo-horizontal-light.svg', 'assets/brand/logo-horizontal-dark.svg', 'assets/icon-16.png', 'assets/icon-32.png', 'assets/icon-48.png', 'assets/icon-128.png']) {
    await access(new URL(file, output));
  }
}

console.log('Build artifacts verified.');