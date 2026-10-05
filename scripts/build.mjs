// Build the client into public/ and the server into dist/.
//   node scripts/build.mjs            -> both
//   node scripts/build.mjs client     -> client only (add --watch to rebuild on change)
//   node scripts/build.mjs server     -> server only
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const only = args.find((a) => a === 'client' || a === 'server');
const out = join(root, process.env.PUBLIC_OUT || 'public');
const BUILD = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + Math.random().toString(36).slice(2, 6);

/** Keep MapLibre as separate ES modules: its worker loads from next to maplibre-gl.js. */
const maplibreExternal = {
  name: 'maplibre-external',
  setup(build) {
    build.onResolve({ filter: /^maplibre-gl$/ }, () => ({ path: './vendor/maplibre/maplibre-gl.js', external: true }));
  },
};

function copyStatic() {
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'client/static'), out, { recursive: true });
  const html = readFileSync(join(root, 'client/static/index.html'), 'utf8').replaceAll('__BUILD__', BUILD);
  writeFileSync(join(out, 'index.html'), html);
  const vendor = join(out, 'vendor/maplibre');
  mkdirSync(vendor, { recursive: true });
  // Shipped as .js (not .mjs): stock nginx/Apache type lists don't know .mjs, and module
  // scripts served as application/octet-stream refuse to load. Internal references follow.
  for (const f of ['maplibre-gl', 'maplibre-gl-shared', 'maplibre-gl-worker']) {
    const src = readFileSync(join(root, 'node_modules/maplibre-gl/dist', `${f}.mjs`), 'utf8')
      .replaceAll('maplibre-gl-shared.mjs', 'maplibre-gl-shared.js')
      .replaceAll('maplibre-gl-worker.mjs', 'maplibre-gl-worker.js')
      .replace(/\/\/# sourceMappingURL=\S+\s*$/, '');
    writeFileSync(join(vendor, `${f}.js`), src);
  }
  cpSync(join(root, 'node_modules/maplibre-gl/LICENSE.txt'), join(vendor, 'LICENSE.txt'));
}

async function buildClient() {
  if (!watch) rmSync(out, { recursive: true, force: true });
  copyStatic();
  const common = {
    bundle: true,
    minify: !watch,
    sourcemap: true,
    target: ['es2021', 'safari15', 'chrome100', 'firefox100'],
    define: { __BUILD__: JSON.stringify(BUILD) },
    logLevel: 'info',
  };
  const contexts = [
    await esbuild.context({
      ...common,
      entryPoints: { app: join(root, 'client/src/main.ts') },
      outdir: out,
      format: 'esm',
      plugins: [maplibreExternal],
    }),
    await esbuild.context({
      ...common,
      entryPoints: { app: join(root, 'client/src/app.css') },
      outdir: out,
      loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    }),
    await esbuild.context({
      ...common,
      entryPoints: { sw: join(root, 'client/src/sw.ts') },
      outdir: out,
      format: 'iife',
    }),
  ];
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log(`Watching client sources (build ${BUILD}); output in ${out}`);
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    console.log(`Client built into ${out} (build ${BUILD})`);
  }
}

async function buildServer() {
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  await esbuild.build({
    entryPoints: {
      server: join(root, 'server/bin/server.ts'),
      migrate: join(root, 'server/bin/migrate.ts'),
      nightly: join(root, 'server/bin/nightly.ts'),
    },
    outdir: dist,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    external: ['pg-native', 'cloudflare:sockets'],
    banner: {
      js: "import { createRequire as __frontierCreateRequire } from 'node:module'; const require = __frontierCreateRequire(import.meta.url);",
    },
    logLevel: 'info',
  });
  cpSync(join(root, 'server/migrations'), join(dist, 'migrations'), { recursive: true });
  console.log('Server built into dist/ (run: node dist/server.mjs)');
}

if (!only || only === 'client') await buildClient();
if (!only || only === 'server') await buildServer();
if (!existsSync(join(root, 'client/static/icons/icon-192.png'))) console.warn('Icons missing: run npm run icons');
