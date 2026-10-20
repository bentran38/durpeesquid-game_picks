'use strict';
const { openDb } = require('./lib/db');
const { createApp } = require('./lib/app');
const { syncSeason, currentSeason } = require('./lib/espn');

const PORT = Number(process.env.PORT) || 3000;
const SYNC_MINUTES = Number(process.env.SYNC_MINUTES ?? 15);

const db = openDb();
const server = createApp(db, { cookieSecure: process.env.COOKIE_SECURE === '1' });

async function refresh() {
  try {
    const season = await currentSeason();
    const n = await syncSeason(db, season);
    console.log(`[sync] ${season}: ${n} games`);
  } catch (e) {
    console.warn('[sync] failed:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`NFL picks running at http://localhost:${PORT}`);
  if (SYNC_MINUTES > 0) {
    refresh();
    setInterval(refresh, SYNC_MINUTES * 60_000).unref();
  }
});
