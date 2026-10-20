// Everything the pages ask the database for. Tables, views and rules are in
// supabase/migrations/20261020000000_picks.sql; the `picks` schema is separate from `public`.
import { supabase } from './session.js';

const db = supabase.schema('picks');
const PAGE = 1000; // PostgREST returns at most 1000 rows per request

const ok = ({ data, error, count }) => {
  if (error) throw new Error(error.message);
  return count == null ? data : { data, count };
};

/** Every row of a query, fetched a page at a time. `build` returns a fresh query each call. */
async function all(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = ok(await build().range(from, from + PAGE - 1));
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// ---- weeks and games ------------------------------------------------------------------------

let periodsCache;
/** Every week that exists, oldest first, with `ended` and `open` flags. */
export async function periods() {
  periodsCache ??= ok(await db.from('periods').select('*').order('season').order('stype').order('week'));
  return periodsCache;
}
export const refreshPeriods = () => { periodsCache = undefined; };

export const seasonsOf = (ps) => [...new Set(ps.map((p) => p.season))].sort((a, b) => b - a);

/** The week to open by default: the first one that has not ended, else the last one played. */
export function currentPeriod(ps) {
  return ps.find((p) => !p.ended) ?? ps[ps.length - 1] ?? null;
}

export async function weekGames({ season, stype, week }) {
  return ok(await db.from('games').select('*').eq('season', season).eq('stype', stype).eq('week', week).order('kickoff').order('id'));
}

// ---- picks ----------------------------------------------------------------------------------

/** A player's picks on these games. Other players' picks come back only for games that have kicked off. */
export async function picksFor(userId, gameIds) {
  if (!gameIds.length) return [];
  return ok(await db.from('picks').select('game_id, home_pick, away_pick').eq('user_id', userId).in('game_id', gameIds));
}

export async function savePicks(userId, rows) {
  if (!rows.length) return;
  ok(await db.from('picks').upsert(rows.map((r) => ({ user_id: userId, ...r })), { onConflict: 'user_id,game_id' }));
}

export async function clearPicks(userId, gameIds) {
  if (!gameIds.length) return;
  ok(await db.from('picks').delete().eq('user_id', userId).in('game_id', gameIds));
}

// ---- people ---------------------------------------------------------------------------------

export async function profileByHandle(handle) {
  const { data } = await supabase.from('profiles').select('user_id, handle, display_name').eq('handle', handle.toLowerCase()).maybeSingle();
  return data;
}

// ---- stats ----------------------------------------------------------------------------------

export const weekScores = ({ userId, season } = {}) => all(() => {
  let q = db.from('week_scores').select('*');
  if (userId) q = q.eq('user_id', userId);
  if (season) q = q.eq('season', season);
  return q;
});

export const weekScoresFor = ({ season, stype, week }) =>
  all(() => db.from('week_scores').select('*').eq('season', season).eq('stype', stype).eq('week', week));

export const seasonScores = ({ userId, season } = {}) => all(() => {
  let q = db.from('season_scores').select('*');
  if (userId) q = q.eq('user_id', userId);
  if (season) q = q.eq('season', season);
  return q;
});

export const teamStats = ({ userId, season } = {}) => all(() => {
  let q = db.from('team_stats').select('*');
  if (userId) q = q.eq('user_id', userId);
  if (season) q = q.eq('season', season);
  return q;
});

export async function streak(userId) {
  const rows = ok(await db.from('streaks').select('longest, current').eq('user_id', userId));
  return rows[0] ?? { longest: 0, current: 0 };
}

export async function teams() {
  return ok(await db.from('teams').select('*').order('name'));
}

/** Best/worst search over weeks or seasons, ranked by the database. */
export async function ranked(view, { column, ascending, minGames, handle, season, worst = false, limit = 50 }) {
  let q = db.from(view).select('*').gte('games', minGames);
  if (handle) q = q.eq('handle', handle.toLowerCase());
  if (season) q = q.eq('season', season);
  q = q.order(column, { ascending });
  // ties: higher winner % is better, then the smaller total-score error (reversed when looking for the worst)
  if (column !== 'pct') q = q.order('pct', { ascending: worst });
  if (column !== 'avg_total_err') q = q.order('avg_total_err', { ascending: !worst });
  return ok(await q.limit(limit));
}

/** Individual scored picks: biggest misses, exact calls, upsets... */
export async function scoredPicks({ handle, season, team, result, order, limit = 50 }) {
  let q = db.from('scored').select('*', { count: 'exact' });
  if (handle) q = q.eq('handle', handle.toLowerCase());
  if (season) q = q.eq('season', season);
  if (team) q = q.or(`home.eq.${team},away.eq.${team}`);
  if (result === 'correct') q = q.eq('correct', true);
  if (result === 'wrong') q = q.eq('correct', false);
  if (result === 'exact') q = q.eq('exact', true);
  q = q.order(order.column, { ascending: order.ascending }).order('kickoff', { ascending: false }).limit(limit);
  const { data, count } = ok(await q);
  return { rows: data, total: count };
}
