'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  stype INTEGER NOT NULL,          -- 2 = regular season, 3 = postseason
  week INTEGER NOT NULL,
  kickoff TEXT NOT NULL,           -- ISO-8601 UTC
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  home_name TEXT NOT NULL,
  away_name TEXT NOT NULL,
  home_logo TEXT,
  away_logo TEXT,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled'   -- scheduled | final
);
CREATE INDEX IF NOT EXISTS games_period ON games(season, stype, week);
CREATE TABLE IF NOT EXISTS picks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  home_pick INTEGER NOT NULL,
  away_pick INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX IF NOT EXISTS picks_game ON picks(game_id);
`;

function openDb(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'picks.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, transaction };
