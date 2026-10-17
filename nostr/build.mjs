// Empaqueta la app Nostr en UN SOLO archivo HTML (sin CDN ni dependencias
// externas): ideal para compartir por WhatsApp/Bluetooth y abrir con file://.
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const result = buildSync({
  entryPoints: [join(src, 'app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
const js = result.outputFiles[0].text;

const css = readFileSync(join(src, 'styles.css'), 'utf8');
let html = readFileSync(join(src, 'index.html'), 'utf8');
html = html.replace('<!--__STYLES__-->', () => `<style>${css}</style>`);
html = html.replace('<!--__BUNDLE__-->', () => `<script>${js}</script>`);

const out = join(dist, 'chatapp-nostr.html');
writeFileSync(out, html);
console.log('OK:', out, Math.round(Buffer.byteLength(html) / 1024) + ' KB');
