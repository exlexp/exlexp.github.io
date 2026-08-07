import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const key = process.env.IWA_SIGNING_KEY;
if (!key || !existsSync(key)) {
  console.error('Set IWA_SIGNING_KEY to an existing offline Ed25519 or P-256 private key. The key is never read by project code or CI.');
  process.exit(2);
}
const executable = join('node_modules', 'wbn-sign', 'bin', 'wbn-sign.js');
const result = spawnSync(process.execPath, [executable, 'sign', '--output', 'dist/relayless.swbn', 'dist/relayless.wbn', key], { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
