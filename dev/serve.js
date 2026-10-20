// `npm run dev:mock`: serves site/ with a fake sign-in and an in-memory database (dev/mock-auth.js),
// so the pages can be tried locally without Supabase or the shared login. Nothing here is deployed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../site', import.meta.url)));
const dev = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8002;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const importMap = `<script type="importmap">${JSON.stringify({ imports: { 'https://www.durpeesquid.com/auth.js': '/__mock-auth.js' } })}</script>`;

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  let file = path === '/__mock-auth.js' ? join(dev, 'mock-auth.js') : resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep) && !file.startsWith(dev + sep)) { res.writeHead(404).end(); return; }
  let body = await readFile(file).catch(() => null);
  if (!body && !extname(path)) { file = join(root, 'index.html'); body = await readFile(file); } // like the Vercel rewrite
  if (!body) { res.writeHead(404).end('not found'); return; }
  if (file.endsWith('index.html')) body = Buffer.from(body.toString().replace('<head>', `<head>${importMap}`));
  res.writeHead(200, { 'content-type': `${TYPES[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}).listen(PORT, () => console.log(`Mock picks site: http://localhost:${PORT}`));
