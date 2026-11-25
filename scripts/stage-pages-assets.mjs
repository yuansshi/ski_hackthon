import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const pagesAssetLimitBytes = 25 * 1024 * 1024;
const publicAssets = [
  ['data', /\.json$/],
  ['clips', /^(?:dh|sg)-athlete-[ab]\.mp4$|^downhill-comparison\.mp4$/],
  ['comparison', /\.(?:csv|json|jpg|webp)$/],
];

async function stageAssets(directory, allowed, recurse) {
  const source = join('public', directory);
  const entries = await readdir(source, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  for (const entry of entries) {
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory() && recurse) {
      await stageAssets(relativePath, allowed, recurse);
    } else if (entry.isFile() && allowed.test(entry.name)) {
      const input = join('public', relativePath);
      const output = join('dist', relativePath);
      const { size } = await stat(input);
      if (size > pagesAssetLimitBytes) {
        throw new Error(`${input} exceeds the Cloudflare Pages asset limit of 25 MiB.`);
      }
      await mkdir(dirname(output), { recursive: true });
      await copyFile(input, output);
    }
  }
}

for (const [directory, allowed] of publicAssets) {
  await stageAssets(directory, allowed, directory !== 'clips');
}
