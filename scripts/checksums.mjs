import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const dist = new URL('../dist', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const names = (await readdir(dist)).filter((name) => /\.(?:wbn|swbn|wasm|json)$/.test(name) && name !== 'SHA256SUMS');
const lines = [];
for (const name of names.sort()) {
  const digest = createHash('sha256').update(await readFile(join(dist, name))).digest('hex');
  lines.push(`${digest}  ${basename(name)}`);
}
await writeFile(join(dist, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${lines.length} checksum(s) to dist/SHA256SUMS`);
