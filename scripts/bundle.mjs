#!/usr/bin/env node
// Path: zn-vault-agent/scripts/bundle.mjs
//
// Bundles zn-vault-agent into a standalone executable using esbuild.
// Creates a single CommonJS file that works without "type": "module" in package.json.

import * as esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
const version = pkg.version;
console.log(`[BUNDLE] Version: ${version}`);

console.log('[BUNDLE] Building TypeScript...');
execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });

// Remove shebang from compiled entry file before bundling (esbuild will add one)
const entryPath = path.join(projectRoot, 'dist/index.js');
let entryContent = fs.readFileSync(entryPath, 'utf-8');
if (entryContent.startsWith('#!')) {
  entryContent = entryContent.replace(/^#!.*\n/, '');
  fs.writeFileSync(entryPath, entryContent);
}

console.log('[BUNDLE] Bundling with esbuild...');

const result = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(projectRoot, 'dist/zn-vault-agent.cjs'),

  // Include all dependencies in the bundle
  packages: 'bundle',

  // Mark native modules as external (they need to be installed separately)
  external: [],

  // Handle dynamic requires
  mainFields: ['module', 'main'],

  // Minify for smaller size
  minify: true,

  // Source map for debugging
  sourcemap: true,

  // Shebang for direct execution
  banner: {
    js: '#!/usr/bin/env node',
  },

  // Define environment and version
  define: {
    'process.env.NODE_ENV': '"production"',
    '__VERSION__': JSON.stringify(version),
  },

  // Log what's being bundled
  metafile: true,
  logLevel: 'info',
});

// Output bundle stats
const metafile = result.metafile;
const output = metafile.outputs[Object.keys(metafile.outputs)[0]];
const sizeKB = Math.round(output.bytes / 1024);

console.log(`[BUNDLE] Output: dist/zn-vault-agent.cjs (${sizeKB} KB)`);
console.log(`[BUNDLE] Inputs: ${Object.keys(output.inputs).length} modules bundled`);

// Make executable
const bundlePath = path.join(projectRoot, 'dist/zn-vault-agent.cjs');
fs.chmodSync(bundlePath, 0o755);

console.log('[BUNDLE] Done!');
