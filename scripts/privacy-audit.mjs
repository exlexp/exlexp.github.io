import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const forbiddenPackages = ['@sentry/', 'posthog', 'firebase', '@supabase/', 'google-analytics', 'mixpanel', 'segment'];
const forbiddenTokens = ['google-analytics.com', 'googletagmanager.com', 'sentry.io', 'api.segment.io', 'app.posthog.com'];
const scannedExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.json', '.webmanifest']);
const allowedClientNetworkFiles = new Set([
  'src/protocols/tox/client.ts',
  'src/protocols/tox/tox.worker.ts',
  'src/protocols/tox/webSocketSocket.ts',
  'src/protocols/xmpp/client.ts',
  'src/protocols/xmpp/discovery.ts',
  'src/protocols/xmpp/registration.ts',
]);
const directNetworkPatterns = [/\bfetch\s*\(/, /\bnew\s+WebSocket\s*\(/, /navigator\.sendBeacon\s*\(/, /\bnew\s+EventSource\s*\(/, /\bXMLHttpRequest\s*\(/];
const forbiddenBrowserStoragePatterns = [/\blocalStorage\b/, /\bsessionStorage\b/, /document\.cookie\b/];
const findings = [];

async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'coverage', 'work'].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.name !== 'privacy-audit.mjs' && scannedExtensions.has(extname(item.name))) {
      const text = await readFile(path, 'utf8');
      const repositoryPath = relative(root, path).replaceAll('\\', '/');
      for (const token of forbiddenTokens) if (text.toLowerCase().includes(token)) findings.push(`${relative(root, path)}: ${token}`);
      if (repositoryPath.startsWith('src/')) {
        for (const pattern of forbiddenBrowserStoragePatterns) {
          if (pattern.test(text)) findings.push(`${repositoryPath}: unencrypted browser storage API ${pattern}`);
        }
        if (!allowedClientNetworkFiles.has(repositoryPath)) {
          for (const pattern of directNetworkPatterns) {
            if (pattern.test(text)) findings.push(`${repositoryPath}: undeclared network primitive ${pattern}`);
          }
        }
      }
    }
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
for (const dependency of dependencies) {
  if (forbiddenPackages.some((item) => dependency.toLowerCase().includes(item))) findings.push(`package.json: ${dependency}`);
}
await walk(root);
if (findings.length) {
  console.error('Privacy audit failed:\n' + findings.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log(`Privacy audit passed: ${dependencies.length} dependencies, no analytics SDKs, no unencrypted browser storage, and no undeclared client network primitives.`);
