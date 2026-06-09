/**
 * FlowMine extension build script.
 *
 * Chrome Manifest V3 service workers are loaded as a single bundled file; the
 * popup is a separate IIFE. esbuild handles both in one pass and copies the
 * static assets (manifest, html, icons) into dist/ so the directory can be
 * loaded straight into chrome://extensions as an unpacked extension.
 *
 * Usage:
 *   pnpm build         one-shot build
 *   pnpm watch         rebuild on save
 */

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const WATCH = process.argv.includes('--watch');

/**
 * Common esbuild config. Service worker target is browser ES2022 because
 * Chrome 110+ supports it and we keep modern syntax (top-level await,
 * nullish coalescing) without transpilation overhead.
 */
const sharedOptions = {
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

async function copyStatic() {
  for (const asset of ['manifest.json', 'popup.html']) {
    const src = path.join(ROOT, asset);
    if (existsSync(src)) {
      await cp(src, path.join(DIST, asset));
    }
  }
  const iconsSrc = path.join(ROOT, 'icons');
  if (existsSync(iconsSrc)) {
    await cp(iconsSrc, path.join(DIST, 'icons'), { recursive: true });
  }
}

async function run() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const entryPoints = {
    background: path.join(ROOT, 'background.ts'),
    popup: path.join(ROOT, 'popup.ts'),
  };

  if (WATCH) {
    const ctx = await context({
      ...sharedOptions,
      entryPoints,
      outdir: DIST,
    });
    await ctx.watch();
    await copyStatic();
    console.log('[flowmine-extension] watching for changes...');
  } else {
    await build({
      ...sharedOptions,
      entryPoints,
      outdir: DIST,
    });
    await copyStatic();
    console.log('[flowmine-extension] build complete -> dist/');
  }
}

run().catch((err) => {
  console.error('[flowmine-extension] build failed:', err);
  process.exit(1);
});
