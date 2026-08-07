import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, 'public', 'tox');
const manifest = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
const entries = manifest.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
if (entries.length !== 2) throw new Error('Tox asset manifest must contain exactly two files');

for (const entry of entries) {
  const match = /^([a-f0-9]{64})\s{2}(toxcore\.(?:mjs|wasm))$/i.exec(entry);
  if (!match) throw new Error(`Invalid Tox checksum entry: ${entry}`);
  const actual = createHash('sha256').update(await readFile(join(directory, match[2]))).digest('hex');
  if (actual !== match[1].toLowerCase()) throw new Error(`Tox asset integrity check failed: ${match[2]}`);
}

console.log('Tox asset integrity verified against the repository manifest.');
