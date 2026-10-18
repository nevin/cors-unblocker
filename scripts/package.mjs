import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const releaseDirectory = join(root, 'release');

await mkdir(releaseDirectory, { recursive: true });

for (const target of ['chrome', 'firefox']) {
  const sourceDirectory = join(root, 'release-dist', target);
  const zipPath = join(releaseDirectory, `${packageJson.name}-${target}-${packageJson.version}.zip`);

  await rm(zipPath, { force: true });
  const result = spawnSync('zip', ['-r', '-X', zipPath, '.'], { cwd: sourceDirectory, stdio: 'inherit' });

  if (result.error || result.status !== 0) {
    throw new Error(`Unable to zip ${target} release build. Ensure the "zip" CLI is installed.`);
  }

  console.log(`Packaged ${zipPath}`);
}
