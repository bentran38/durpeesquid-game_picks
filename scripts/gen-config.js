// Writes site/config.js from env vars (Vercel) or .env.local (local dev).
// config.js is gitignored: the Supabase URL and key never go in the repo.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const fromFile = {};
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const get = (k) => process.env[k] || fromFile[k] || '';

const url = get('VITE_SUPABASE_URL');
const key = get('VITE_SUPABASE_PUBLISHABLE_KEY');
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY (set them in .env.local or the Vercel project env vars).');
  process.exit(1);
}

writeFileSync(
  'site/config.js',
  `export const SUPABASE_URL = ${JSON.stringify(url)};\nexport const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(key)};\n`,
);
console.log('wrote site/config.js');
