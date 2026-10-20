'use strict';
const { transaction } = require('./db');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
// ESPN week numbers: regular season 1-18; postseason 1 Wild Card, 2 Divisional, 3 Conference, 5 Super Bowl (4 is the Pro Bowl)
const PERIODS = [
  ...Array.from({ length: 18 }, (_, i) => [2, i + 1]),
  [3, 1], [3, 2], [3, 3], [3, 5],
];

async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  return res.json();
}

function parseEvent(e, season, stype, week) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === 'home');
  const away = comp?.competitors?.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  // playoff matchups that aren't decided yet come through as placeholders
  const isTbd = (c) => !c.team?.abbreviation || /^(TBD|TBA)$/i.test(c.team.abbreviation);
  if (isTbd(home) || isTbd(away)) return null;
  const final = !!e.status?.type?.completed;
  const num = (c) => (final && c.score != null && c.score !== '' ? Number(c.score) : null);
  return {
    id: String(e.id), season, stype, week,
    kickoff: new Date(e.date).toISOString(),
    home: home.team.abbreviation, away: away.team.abbreviation,
    home_name: home.team.displayName, away_name: away.team.displayName,
    home_logo: home.team.logo ?? null, away_logo: away.team.logo ?? null,
    home_score: num(home), away_score: num(away),
    status: final ? 'final' : 'scheduled',
  };
}

function upsertGames(db, games) {
  const stmt = db.prepare(`
    INSERT INTO games (id, season, stype, week, kickoff, home, away, home_name, away_name, home_logo, away_logo, home_score, away_score, status)
    VALUES (:id, :season, :stype, :week, :kickoff, :home, :away, :home_name, :away_name, :home_logo, :away_logo, :home_score, :away_score, :status)
    ON CONFLICT(id) DO UPDATE SET
      season=excluded.season, stype=excluded.stype, week=excluded.week, kickoff=excluded.kickoff,
      home_score=excluded.home_score, away_score=excluded.away_score, status=excluded.status,
      home_logo=excluded.home_logo, away_logo=excluded.away_logo`);
  transaction(db, () => { for (const g of games) stmt.run(g); });
}

/** Pull one season's schedule and results from ESPN. Safe to run repeatedly. */
async function syncSeason(db, season, { fetchImpl = fetch, periods = PERIODS } = {}) {
  let count = 0;
  for (const [stype, week] of periods) {
    let json;
    try {
      json = await fetchJson(`${BASE}?dates=${season}&seasontype=${stype}&week=${week}&limit=100`, fetchImpl);
    } catch (e) {
      console.warn(`sync ${season} type ${stype} week ${week}: ${e.message}`);
      continue;
    }
    const games = (json.events || []).map((e) => parseEvent(e, season, stype, week)).filter(Boolean);
    upsertGames(db, games);
    count += games.length;
  }
  return count;
}

async function currentSeason(fetchImpl = fetch) {
  const json = await fetchJson(BASE, fetchImpl);
  return json.leagues?.[0]?.season?.year ?? json.season?.year ?? new Date().getFullYear();
}

module.exports = { syncSeason, currentSeason, parseEvent, upsertGames };
