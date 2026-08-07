import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../work/iwa-development-ed25519.pem', import.meta.url);
const { privateKey } = generateKeyPairSync('ed25519');
await mkdir(new URL('../work/', import.meta.url), { recursive: true });
await writeFile(output, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
console.log('Created work/iwa-development-ed25519.pem. Development use only; never publish this key.');
