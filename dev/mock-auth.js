// Stand-in for https://www.durpeesquid.com/auth.js, used only by `npm run dev:mock` (dev/serve.js maps
// the real URL to this file). It fakes a signed-in user and a small in-memory copy of the picks
// schema, so the pages can be tried locally without Supabase. The real rules live in the migration.
import { scorePick } from '/scoring.js';

export const HOME = location.origin;
export const requireLogin = async () => ({ user: { id: 'me', email: 'you@example.com' } });
export const hasAccess = async () => true;
export const signOut = () => alert('Mock sign out');
export const loadProfile = async () => ({ handle: 'you', display_name: 'You', theme: 'midnight' });

// ---- fake data ------------------------------------------------------------------------------

const TEAMS = 'ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LV LAC LAR MIA MIN NE NO NYG NYJ PHI PIT SF SEA TB TEN WSH'.split(' ');
const DAY = 864e5;
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const games = [];
const now = Date.now();
for (const [season, firstWeekStart] of [[2025, now - 400 * DAY], [2026, now - 36 * DAY]]) {
  for (let week = 1; week <= 18; week++) {
    const order = [...TEAMS].sort(() => rand() - 0.5);
    for (let i = 0; i < 16; i++) {
      const kickoff = firstWeekStart + (week - 1) * 7 * DAY + (i % 4) * 3 * 3600e3;
      const done = kickoff < now - 4 * 3600e3;
      const hs = done ? Math.round(10 + rand() * 28) : null, as = done ? Math.round(7 + rand() * 28) : null;
      const [home, away] = [order[i * 2], order[i * 2 + 1]];
      games.push({
        id: `${season}-${week}-${i}`, season, stype: 2, week, kickoff: new Date(kickoff).toISOString(), home, away,
        home_name: `${home} Team`, away_name: `${away} Team`, home_logo: null, away_logo: null,
        home_score: hs, away_score: as, status: done ? 'final' : 'scheduled',
      });
    }
  }
}

// one game in progress, to try the live display
{
  const g = games.find((x) => x.season === 2026 && x.week === 7 && x.stype === 2);
  Object.assign(g, { status: 'live', kickoff: new Date(now - 3600e3).toISOString(), home_score: 14, away_score: 10, detail: '5:21 - 3rd',
    possession: g.home, down_distance: '2nd & 8', field_pos: `${g.away} 35`, red_zone: false });
}

const people = [
  { user_id: 'me', handle: 'you', name: 'You', skill: 6 }, { user_id: 'u1', handle: 'gridiron_gus', name: 'Gus', skill: 3 },
  { user_id: 'u2', handle: 'blitz_betty', name: 'Betty', skill: 7 }, { user_id: 'u3', handle: 'the_oracle', name: 'The Oracle', skill: 4 },
];
const picks = [];
for (const p of people) {
  for (const g of games) {
    if (g.status !== 'final' || rand() < 0.05) continue;
    const n = () => Math.round((rand() + rand() + rand() - 1.5) * p.skill);
    picks.push({ user_id: p.user_id, game_id: g.id, home_pick: Math.max(0, g.home_score + n()), away_pick: Math.max(0, g.away_score + n()) });
  }
}
{
  const live = games.find((g) => g.status === 'live');
  picks.push({ user_id: 'me', game_id: live.id, home_pick: 20, away_pick: 13 });
}
const profiles = people.map((p) => ({ user_id: p.user_id, handle: p.handle, display_name: p.name }));

// ---- views (same formulas as the SQL) ---------------------------------------------------------

const person = (id) => people.find((p) => p.user_id === id);
const gameById = new Map(games.map((g) => [g.id, g]));
const lockedGame = (g) => g.status === 'final' || new Date(g.kickoff) <= now;

function periodsView() {
  const m = new Map();
  for (const g of games) {
    const k = `${g.season}|${g.stype}|${g.week}`;
    const p = m.get(k) ?? { season: g.season, stype: g.stype, week: g.week, games: 0, final_games: 0, first_kickoff: g.kickoff, last_kickoff: g.kickoff };
    p.games++; p.final_games += g.status === 'final' ? 1 : 0;
    if (g.kickoff > p.last_kickoff) p.last_kickoff = g.kickoff;
    m.set(k, p);
  }
  const list = [...m.values()].sort((a, b) => a.season - b.season || a.stype - b.stype || a.week - b.week);
  let allEnded = true;
  for (const p of list) {
    p.ended = p.final_games === p.games || new Date(p.last_kickoff).getTime() + 3 * DAY < now;
    p.open = allEnded;
    allEnded = allEnded && p.ended;
  }
  return list;
}

const scored = () => picks.filter((p) => gameById.get(p.game_id).status === 'final').map((p) => {
  const g = gameById.get(p.game_id), s = scorePick(p, g), who = person(p.user_id);
  return { ...g, game_id: g.id, user_id: p.user_id, name: who.name, handle: who.handle, home_pick: p.home_pick, away_pick: p.away_pick,
    correct: s.correct, exact: s.exact, margin_err: s.marginErr, total_err: s.totalErr, points: s.points, blowout: Math.abs(g.home_score - g.away_score) };
});

function agg(rows, keys) {
  const m = new Map();
  for (const r of rows) {
    const k = keys.map((c) => r[c]).join('|');
    const a = m.get(k) ?? { ...Object.fromEntries(keys.map((c) => [c, r[c]])), name: r.name, handle: r.handle, games: 0, correct: 0, exact: 0, points: 0, margin_err_sum: 0, total_err_sum: 0 };
    a.games++; a.correct += +r.correct; a.exact += +r.exact; a.points += r.points; a.margin_err_sum += r.margin_err; a.total_err_sum += r.total_err;
    m.set(k, a);
  }
  const fin = periodsView();
  return [...m.values()].map((a) => ({
    ...a, pct: +(100 * a.correct / a.games).toFixed(1), avg_points: +(a.points / a.games).toFixed(2),
    avg_margin_err: +(a.margin_err_sum / a.games).toFixed(2), avg_total_err: +(a.total_err_sum / a.games).toFixed(2),
    games_in_week: fin.find((p) => p.season === a.season && p.stype === a.stype && p.week === a.week)?.final_games ?? a.games,
  }));
}

const VIEWS = {
  periods: periodsView,
  scored,
  week_scores: () => agg(scored(), ['user_id', 'season', 'stype', 'week']),
  season_scores: () => agg(scored(), ['user_id', 'season']),
  team_stats: () => {
    const sides = scored().flatMap((r) => [
      { ...r, team: r.home, team_name: r.home_name, team_logo: null, pf: r.home_pick, pa: r.away_pick, af: r.home_score, aa: r.away_score },
      { ...r, team: r.away, team_name: r.away_name, team_logo: null, pf: r.away_pick, pa: r.home_pick, af: r.away_score, aa: r.home_score },
    ]);
    return agg(sides, ['user_id', 'season', 'team']).map((a) => {
      const rows = sides.filter((r) => r.user_id === a.user_id && r.season === a.season && r.team === a.team);
      return { ...a, picked_win: rows.filter((r) => r.pf > r.pa).length, actual_win: rows.filter((r) => r.af > r.aa).length,
        pred_for: rows.reduce((s, r) => s + r.pf, 0), actual_for: rows.reduce((s, r) => s + r.af, 0), team_name: rows[0].team_name, team_logo: null };
    });
  },
  streaks: () => people.map((p) => {
    const rows = scored().filter((r) => r.user_id === p.user_id).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    let cur = 0, best = 0;
    for (const r of rows) { cur = r.correct ? cur + 1 : 0; best = Math.max(best, cur); }
    return { user_id: p.user_id, longest: best, current: cur };
  }),
  teams: () => TEAMS.map((t) => ({ abbr: t, name: `${t} Team`, logo: null })),
  games: () => games,
  picks: () => picks.filter((p) => p.user_id === 'me' || lockedGame(gameById.get(p.game_id))),
};

// ---- query builder shaped like the parts of supabase-js the pages use ---------------------------

class Query {
  constructor(table) { this.table = table; this.filters = []; this.sorts = []; this.opts = {}; this.op = 'select'; }
  select(_cols, opts = {}) { this.opts = opts; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
  not(c, _op, v) { this.filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return this; }
  or(expr) {
    const parts = expr.split(',').map((p) => p.split('.'));
    this.filters.push((r) => parts.some(([c, op, v]) => (op === 'eq' ? r[c] === v : String(r[c] ?? '').toLowerCase().startsWith(v.replace('%', '').toLowerCase()))));
    return this;
  }
  order(c, { ascending = true } = {}) { this.sorts.push([c, ascending]); return this; }
  limit(n) { this.max = n; return this; }
  range(a, b) { this.from = a; this.to = b; return this; }
  maybeSingle() { this.single = true; return this; }
  upsert(rows) { this.op = 'upsert'; this.rows = [].concat(rows); return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }

  run() {
    if (this.table === 'picks' && this.op !== 'select') return this.write();
    let rows = (this.table === 'profiles' ? profiles : VIEWS[this.table]()).filter((r) => this.filters.every((f) => f(r)));
    for (const [c, asc] of [...this.sorts].reverse()) rows.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    const count = rows.length;
    if (this.from != null) rows = rows.slice(this.from, this.to + 1);
    if (this.max != null) rows = rows.slice(0, this.max);
    return { data: this.single ? rows[0] ?? null : rows, error: null, count: this.opts.count ? count : null };
  }

  write() {
    const periods = periodsView();
    const pickable = (id) => {
      const g = gameById.get(id);
      return g && g.status !== 'final' && new Date(g.kickoff) > now && periods.find((p) => p.season === g.season && p.stype === g.stype && p.week === g.week).open;
    };
    const deny = { data: null, error: { message: 'new row violates row-level security policy for table "picks"' } };
    if (this.op === 'upsert') {
      if (!this.rows.every((r) => pickable(r.game_id))) return deny;
      for (const r of this.rows) {
        const old = picks.find((p) => p.user_id === 'me' && p.game_id === r.game_id);
        if (old) Object.assign(old, r); else picks.push({ ...r, user_id: 'me' });
      }
    } else {
      for (let i = picks.length - 1; i >= 0; i--) if (picks[i].user_id === 'me' && this.filters.every((f) => f(picks[i])) && pickable(picks[i].game_id)) picks.splice(i, 1);
    }
    return { data: null, error: null };
  }
}

const from = (table) => new Query(table);
export const supabase = { from, schema: () => ({ from }) };
