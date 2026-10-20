'use strict';
const { scorePick } = require('./scoring');

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** All of one or more users' picks on finished games, with scores attached. */
function loadScored(db, { userId, username, season, stype, week, team } = {}) {
  const where = [`g.status = 'final'`];
  const args = [];
  if (userId != null) { where.push('p.user_id = ?'); args.push(userId); }
  if (username) { where.push('u.username = ?'); args.push(username); }
  if (season != null) { where.push('g.season = ?'); args.push(season); }
  if (stype != null) { where.push('g.stype = ?'); args.push(stype); }
  if (week != null) { where.push('g.week = ?'); args.push(week); }
  if (team) { where.push('(g.home = ? OR g.away = ?)'); args.push(team, team); }
  const rows = db.prepare(`
    SELECT p.user_id, u.username, p.home_pick, p.away_pick, g.*
    FROM picks p JOIN games g ON g.id = p.game_id JOIN users u ON u.id = p.user_id
    WHERE ${where.join(' AND ')}`).all(...args);
  return rows.map((r) => ({ ...r, s: scorePick(r, r) }));
}

function summarize(rows) {
  const n = rows.length;
  if (!n) return { games: 0, correct: 0, pct: null, points: 0, avgPoints: null, exact: 0, avgMarginErr: null, avgTotalErr: null };
  let correct = 0, exact = 0, points = 0, marginErr = 0, totalErr = 0;
  for (const r of rows) {
    correct += r.s.correct ? 1 : 0;
    exact += r.s.exact ? 1 : 0;
    points += r.s.points;
    marginErr += r.s.marginErr;
    totalErr += r.s.totalErr;
  }
  return {
    games: n, correct, pct: round(correct / n * 100, 1), points,
    avgPoints: round(points / n), exact,
    avgMarginErr: round(marginErr / n), avgTotalErr: round(totalErr / n),
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** One entry per (user, week): the unit for "best week" / "worst week" searches. */
function weekEntries(rows, db) {
  const totals = new Map(
    db.prepare(`SELECT season, stype, week, COUNT(*) n FROM games WHERE status='final' GROUP BY season, stype, week`)
      .all().map((t) => [`${t.season}|${t.stype}|${t.week}`, t.n]),
  );
  return [...groupBy(rows, (r) => `${r.user_id}|${r.season}|${r.stype}|${r.week}`).values()].map((g) => {
    const f = g[0];
    return {
      user: f.username, season: f.season, stype: f.stype, week: f.week,
      gamesInWeek: totals.get(`${f.season}|${f.stype}|${f.week}`) ?? g.length,
      ...summarize(g),
    };
  });
}

function seasonEntries(rows) {
  return [...groupBy(rows, (r) => `${r.user_id}|${r.season}`).values()].map((g) => ({
    user: g[0].username, season: g[0].season, ...summarize(g),
  }));
}

const periodOrder = (e) => e.season * 1000 + e.stype * 100 + e.week;

/**
 * Per-team breakdown over games involving the team.
 * pickedWinPct vs actualWinPct shows which teams a player over- or under-rates.
 */
function teamEntries(rows) {
  const out = new Map();
  for (const r of rows) {
    for (const side of ['home', 'away']) {
      const other = side === 'home' ? 'away' : 'home';
      const t = r[side];
      if (!out.has(t)) out.set(t, { team: t, name: r[`${side}_name`], logo: r[`${side}_logo`], rows: [], pickedWin: 0, actualWin: 0, predFor: 0, actualFor: 0 });
      const e = out.get(t);
      e.rows.push(r);
      if (r[`${side}_pick`] > r[`${other}_pick`]) e.pickedWin++;
      if (r[`${side}_score`] > r[`${other}_score`]) e.actualWin++;
      e.predFor += r[`${side}_pick`];
      e.actualFor += r[`${side}_score`];
    }
  }
  return [...out.values()].map((e) => ({
    team: e.team, name: e.name, logo: e.logo,
    ...summarize(e.rows),
    pickedWinPct: round(e.pickedWin / e.rows.length * 100, 1),
    actualWinPct: round(e.actualWin / e.rows.length * 100, 1),
    // positive = picked to win more often than they actually did (overrated)
    bias: round((e.pickedWin - e.actualWin) / e.rows.length * 100, 1),
    avgPredPoints: round(e.predFor / e.rows.length, 1),
    avgActualPoints: round(e.actualFor / e.rows.length, 1),
  }));
}

function leaderboard(rows, { sort = 'points', min = 1 } = {}) {
  const board = [...groupBy(rows, (r) => r.user_id).values()]
    .map((g) => ({ user: g[0].username, ...summarize(g) }))
    .filter((e) => e.games >= min);
  const cmp = {
    points: (a, b) => b.points - a.points,
    avgPoints: (a, b) => b.avgPoints - a.avgPoints,
    pct: (a, b) => b.pct - a.pct,
    marginErr: (a, b) => a.avgMarginErr - b.avgMarginErr,
    exact: (a, b) => b.exact - a.exact,
  }[sort] || ((a, b) => b.points - a.points);
  board.sort((a, b) => cmp(a, b) || b.points - a.points || a.avgMarginErr - b.avgMarginErr || a.user.localeCompare(b.user));
  return board.map((e, i) => ({ rank: i + 1, ...e }));
}

function bestWorst(entries, key = 'points', minGames = 1) {
  const eligible = entries.filter((e) => e.games >= minGames);
  if (!eligible.length) return { best: null, worst: null };
  const sorted = [...eligible].sort((a, b) => b[key] - a[key]);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

module.exports = {
  loadScored, summarize, groupBy, weekEntries, seasonEntries, teamEntries,
  leaderboard, bestWorst, periodOrder, round,
};
