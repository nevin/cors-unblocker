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

  // Chrome needs the policy schema the manifest points to, or enterprise policy is ignored.
  if (target === 'chrome') {
    await access(new URL(manifest.storage.managed_schema, output));
  }
}

// The end-to-end control bridge must never reach a normal or release build.
for (const directory of ['dist', 'release-dist']) {
  for (const target of ['chrome', 'firefox']) {
    const output = new URL(`../${directory}/${target}/`, import.meta.url);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(new URL('manifest.json', output), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.content_scripts || JSON.stringify(manifest).includes('e2e')) {
      throw new Error(`${directory}/${target} contains the end-to-end test bridge`);
    }
    try {
      await access(new URL('e2e/', output));
      throw new Error(`${directory}/${target} contains an e2e folder`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('e2e folder')) {
        throw error;
      }
    }
  }
}

console.log('Build artifacts verified.');