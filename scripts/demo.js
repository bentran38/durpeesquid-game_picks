'use strict';
// Fills the database with fake players whose picks are noisy guesses at real results, so every
// page has something to show. Requires games to be synced first:  npm run sync -- 2023 2024 2025
// Demo accounts all use the password "demopass123".
const { openDb, transaction } = require('../lib/db');
const { hashPassword } = require('../lib/app');

const db = openDb();
const games = db.prepare(`SELECT * FROM games WHERE status = 'final'`).all();
if (!games.length) {
  console.error('No finished games found. Run `npm run sync -- 2024 2025` first.');
  process.exit(1);
}

const names = ['gridiron_gus', 'blitz_betty', 'hailmary_hank', 'the_oracle', 'punt_prince', 'sunday_sam'];
// each demo player has a different skill (lower noise = better) and a home-team lean
const skill = [4, 7, 11, 5, 9, 8];
const lean = [0, 2, -1, 0, 3, 1];

// deterministic PRNG so reruns produce the same data
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const noise = (s) => Math.round((rand() + rand() + rand() - 1.5) * s);

const insUser = db.prepare('INSERT OR IGNORE INTO users (username, pass_hash) VALUES (?, ?)');
const insPick = db.prepare('INSERT OR REPLACE INTO picks (user_id, game_id, home_pick, away_pick) VALUES (?,?,?,?)');
const hash = hashPassword('demopass123');

transaction(db, () => {
  names.forEach((name, i) => {
    insUser.run(name, hash);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    for (const g of games) {
      if (rand() < 0.04) continue; // skipped a game now and then
      const home = Math.max(0, Math.min(60, g.home_score + noise(skill[i]) + lean[i]));
      const away = Math.max(0, Math.min(60, g.away_score + noise(skill[i])));
      insPick.run(id, g.id, home, away);
    }
  });
});
console.log(`Created ${names.length} demo players with picks on ${games.length} finished games.`);
