'use strict';
// Usage: npm run sync -- 2021 2022 2023   (no args = current season)
const { openDb } = require('../lib/db');
const { syncSeason, currentSeason } = require('../lib/espn');

(async () => {
  const db = openDb();
  const seasons = process.argv.slice(2).map(Number).filter(Boolean);
  if (!seasons.length) seasons.push(await currentSeason());
  for (const s of seasons) console.log(`Season ${s}: ${await syncSeason(db, s)} games synced`);
})().catch((e) => { console.error(e); process.exit(1); });
