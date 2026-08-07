import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const forbiddenPackages = ['@sentry/', 'posthog', 'firebase', '@supabase/', 'google-analytics', 'mixpanel', 'segment'];
const forbiddenTokens = ['google-analytics.com', 'googletagmanager.com', 'sentry.io', 'api.segment.io', 'app.posthog.com'];
const scannedExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.json', '.webmanifest']);
const findings = [];

async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'coverage', 'work'].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.name !== 'privacy-audit.mjs' && scannedExtensions.has(extname(item.name))) {
      const text = await readFile(path, 'utf8');
      for (const token of forbiddenTokens) if (text.toLowerCase().includes(token)) findings.push(`${relative(root, path)}: ${token}`);
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
console.log(`Privacy audit passed: ${dependencies.length} dependencies and repository sources contain no forbidden analytics endpoints or SDKs.`);
