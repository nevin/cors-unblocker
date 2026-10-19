import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Firefox Add-ons (AMO) reviewers need the source of bundled or minified add-ons to rebuild and compare.
// This archives the committed tree at HEAD, so the archive always matches the commit being released.
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const name = `${packageJson.name}-source-${packageJson.version}`;
const zipPath = join(root, 'release', `${name}.zip`);

await mkdir(join(root, 'release'), { recursive: true });
await rm(zipPath, { force: true });
const result = spawnSync('git', ['archive', '--format=zip', `--prefix=${name}/`, '-o', zipPath, 'HEAD'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  throw new Error('Unable to archive the source. Run this inside the git repository.');
}

console.log(`Packaged ${zipPath}`);
