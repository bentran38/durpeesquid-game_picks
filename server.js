'use strict';
const { openDb } = require('./lib/db');
const { createApp } = require('./lib/app');
const { syncSeason, currentSeason } = require('./lib/espn');

const PORT = Number(process.env.PORT) || 3000;
const IDLE_MINUTES = Number(process.env.SYNC_MINUTES ?? 30);   // 0 disables syncing
const LIVE_MINUTES = Number(process.env.LIVE_SYNC_MINUTES ?? 2); // while games are in progress
const BACKFILL_FROM = Number(process.env.BACKFILL_FROM || 0);   // e.g. 2020: load older seasons once on startup

const db = openDb();
const server = createApp(db, { cookieSecure: process.env.COOKIE_SECURE === '1' });

// Games that kicked off in the last 6 hours and aren't final: scores are changing, poll faster.
const gamesLive = () => db.prepare(`SELECT 1 FROM games WHERE status != 'final' AND kickoff <= ? AND kickoff >= ? LIMIT 1`)
  .get(new Date().toISOString(), new Date(Date.now() - 6 * 3600e3).toISOString()) != null;

async function refresh() {
  try {
    // Sync the season ESPN considers current AND the next one, so a new season's schedule appears
    // the moment ESPN publishes it, with no manual step, forever.
    const season = await currentSeason();
    for (const s of [season, season + 1]) {
      const n = await syncSeason(db, s);
      if (n) console.log(`[sync] ${s}: ${n} games`);
    }
  } catch (e) {
    console.warn('[sync] failed:', e.message);
  }
}

async function backfill() {
  if (!BACKFILL_FROM) return;
  const have = new Set(db.prepare('SELECT DISTINCT season FROM games').all().map((r) => r.season));
  for (let s = BACKFILL_FROM; s <= new Date().getFullYear(); s++) {
    if (!have.has(s)) console.log(`[backfill] ${s}: ${await syncSeason(db, s)} games`);
  }
}

async function loop() {
  await refresh();
  setTimeout(loop, (gamesLive() ? LIVE_MINUTES : IDLE_MINUTES) * 60_000).unref?.();
}

server.listen(PORT, () => {
  console.log(`NFL picks running at http://localhost:${PORT}`);
  if (IDLE_MINUTES > 0) backfill().then(loop);
});
