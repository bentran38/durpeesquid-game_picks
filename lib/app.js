'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transaction } = require('./db');
const { scorePick, WINNER, MARGIN_MAX, EXACT } = require('./scoring');
const S = require('./stats');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 90;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

function intParam(v) {
  if (v == null || v === '') return undefined;
  if (!Number.isInteger(Number(v))) throw bad('Expected an integer');
  return Number(v);
}
const limitParam = (v, def = 50) => Math.min(200, Math.max(1, intParam(v) ?? def));

// error-style stats: lower is better
const LOWER_IS_BETTER = new Set(['avgMarginErr', 'avgTotalErr']);
const SORT_KEYS = new Set(['points', 'pct', 'avgPoints', 'avgMarginErr', 'avgTotalErr', 'exact', 'correct']);

function rank(entries, key, order, tiebreak = 'points') {
  if (!SORT_KEYS.has(key)) throw bad(`sort must be one of ${[...SORT_KEYS].join(', ')}`);
  const bestIsLow = LOWER_IS_BETTER.has(key);
  const dir = (order === 'worst') === bestIsLow ? -1 : 1; // 1 = ascending
  return [...entries].sort((a, b) => dir * (a[key] - b[key]) || (order === 'worst' ? a[tiebreak] - b[tiebreak] : b[tiebreak] - a[tiebreak]));
}

function createApp(db, { cookieSecure = false } = {}) {
  const q = (sql) => db.prepare(sql);
  const attempts = new Map();

  function throttle(ip) {
    const now = Date.now();
    const rec = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    if (rec.length >= 20) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
    rec.push(now);
    attempts.set(ip, rec);
  }

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
      .run(sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
    res.setHeader('Set-Cookie', cookie(token, SESSION_DAYS * 86400));
  }
  const cookie = (v, maxAge) =>
    `sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;

  function sessionUser(req) {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const row = q(`SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
      .get(sha256(m[1]));
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, username: row.username };
  }

  const need = (ctx) => { if (!ctx.user) throw new HttpError(401, 'Log in first'); return ctx.user; };
  const findUser = (name) => {
    const u = q('SELECT id, username, created_at FROM users WHERE username = ?').get(name);
    if (!u) throw new HttpError(404, 'No such user');
    return u;
  };

  const locked = (g) => g.status === 'final' || new Date(g.kickoff).getTime() <= Date.now();

  // Weeks unlock one at a time: a week opens for picks once every earlier week (across seasons) has ended.
  // A week has ended when all its games are final, or its last kickoff was over 3 days ago
  // (so a postponed or cancelled game can never block the schedule forever).
  const ENDED_GRACE_MS = 3 * 864e5;
  function periodStates() {
    const rows = q(`SELECT season, stype, week, SUM(status != 'final') pending, MAX(kickoff) lastKickoff
      FROM games GROUP BY season, stype, week ORDER BY season, stype, week`).all();
    const now = Date.now();
    let blocker = null;
    const states = new Map();
    for (const r of rows) {
      const ended = r.pending === 0 || new Date(r.lastKickoff).getTime() + ENDED_GRACE_MS < now;
      states.set(`${r.season}|${r.stype}|${r.week}`, { ...r, ended, open: !blocker, opensAfter: blocker });
      if (!ended && !blocker) blocker = { season: r.season, stype: r.stype, week: r.week };
    }
    return states;
  }
  const stateKey = (g) => `${g.season}|${g.stype}|${g.week}`;

  function gameView(g, pick, open = false) {
    const s = pick ? scorePick(pick, g) : null;
    return {
      id: g.id, season: g.season, stype: g.stype, week: g.week, kickoff: g.kickoff, status: g.status, locked: locked(g),
      pickable: open && !locked(g),
      home: { abbr: g.home, name: g.home_name, logo: g.home_logo, score: g.home_score },
      away: { abbr: g.away, name: g.away_name, logo: g.away_logo, score: g.away_score },
      pick: pick ? { home: pick.home_pick, away: pick.away_pick } : null,
      result: s,
    };
  }

  function periodFilter(query) {
    const f = { season: intParam(query.get('season')), stype: intParam(query.get('stype')), week: intParam(query.get('week')) };
    return f;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  route('POST', '/api/register', (ctx) => {
    throttle(ctx.ip);
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(username)) throw bad('Username: 3-20 letters, numbers or underscores');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw bad('Password must be at least 8 characters');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    const r = q('INSERT INTO users (username, pass_hash) VALUES (?,?)').run(username, hashPassword(password));
    startSession(ctx.res, Number(r.lastInsertRowid));
    return { username };
  });

  route('POST', '/api/login', (ctx) => {
    throttle(ctx.ip);
    const { username, password } = ctx.body;
    const u = typeof username === 'string' ? q('SELECT * FROM users WHERE username = ?').get(username) : null;
    if (!u || typeof password !== 'string' || !verifyPassword(password, u.pass_hash)) throw new HttpError(401, 'Wrong username or password');
    startSession(ctx.res, u.id);
    return { username: u.username };
  });

  route('POST', '/api/logout', (ctx) => {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(ctx.req.headers.cookie || '');
    if (m) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(m[1]));
    ctx.res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  });

  route('GET', '/api/me', (ctx) => ({
    user: ctx.user, scoring: { winner: WINNER, marginBonusMax: MARGIN_MAX, exact: EXACT },
  }));

  route('GET', '/api/seasons', () => {
    const seasons = q(`SELECT season, COUNT(*) games, SUM(status='final') finalGames FROM games GROUP BY season ORDER BY season DESC`).all();
    return { seasons };
  });

  // Weeks in a season, plus which one to open by default (first with an unfinished game, else the last).
  route('GET', '/api/periods', (ctx) => {
    const season = intParam(ctx.query.get('season'));
    if (season == null) throw bad('season required');
    const states = periodStates();
    const periods = q(`SELECT stype, week, COUNT(*) games, SUM(status='final') finalGames, MIN(kickoff) firstKickoff
      FROM games WHERE season = ? GROUP BY stype, week ORDER BY stype, week`).all(season)
      .map((p) => ({ ...p, open: states.get(`${season}|${p.stype}|${p.week}`).open }));
    // default week: the first one that hasn't ended yet, else the last one played
    const current = periods.find((p) => !states.get(`${season}|${p.stype}|${p.week}`).ended) || periods[periods.length - 1] || null;
    return { periods, current: current && { stype: current.stype, week: current.week } };
  });

  route('GET', '/api/teams', () => ({
    // bare columns take their values from the MAX(kickoff) row, i.e. the team's latest name/logo
    teams: q(`SELECT abbr, name, logo, MAX(kickoff) latest FROM (
      SELECT home abbr, home_name name, home_logo logo, kickoff FROM games
      UNION ALL SELECT away, away_name, away_logo, kickoff FROM games)
      GROUP BY abbr ORDER BY name`).all().map(({ abbr, name, logo }) => ({ abbr, name, logo })),
  }));

  route('GET', '/api/games', (ctx) => {
    const { season, stype, week } = periodFilter(ctx.query);
    if (season == null || stype == null || week == null) throw bad('season, stype and week required');
    const games = q('SELECT * FROM games WHERE season=? AND stype=? AND week=? ORDER BY kickoff, id').all(season, stype, week);
    const picks = new Map();
    if (ctx.user) {
      for (const p of q(`SELECT p.* FROM picks p JOIN games g ON g.id=p.game_id WHERE p.user_id=? AND g.season=? AND g.stype=? AND g.week=?`)
        .all(ctx.user.id, season, stype, week)) picks.set(p.game_id, p);
    }
    const st = periodStates().get(`${season}|${stype}|${week}`);
    const views = games.map((g) => gameView(g, picks.get(g.id), !!st?.open));
    return { open: !!st?.open, opensAfter: st?.opensAfter ?? null, games: views, week: S.summarize(views.filter((v) => v.result).map((v) => ({ s: v.result }))) };
  });

  route('PUT', '/api/picks', (ctx) => {
    const user = need(ctx);
    const list = ctx.body.picks;
    if (!Array.isArray(list) || !list.length || list.length > 40) throw bad('Send 1-40 picks');
    const get = q('SELECT * FROM games WHERE id = ?');
    const upsert = q(`INSERT INTO picks (user_id, game_id, home_pick, away_pick) VALUES (?,?,?,?)
      ON CONFLICT(user_id, game_id) DO UPDATE SET home_pick=excluded.home_pick, away_pick=excluded.away_pick,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    const saved = [];
    const rejected = [];
    const states = periodStates();
    transaction(db, () => {
      for (const p of list) {
        const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 99;
        if (!p || !ok(p.home) || !ok(p.away)) throw bad('Scores must be whole numbers from 0 to 99');
        const g = get.get(String(p.gameId));
        if (!g) throw new HttpError(404, `Unknown game ${p.gameId}`);
        if (locked(g)) { rejected.push({ gameId: g.id, reason: 'locked' }); continue; }
        if (!states.get(stateKey(g))?.open) { rejected.push({ gameId: g.id, reason: 'not_open_yet' }); continue; }
        upsert.run(user.id, g.id, p.home, p.away);
        saved.push(g.id);
      }
    });
    return { saved, rejected };
  });

  // A user's picks. Other people only see games that have kicked off, so nobody can copy picks.
  route('GET', '/api/users/([^/]+)/picks', (ctx) => {
    const target = findUser(decodeURIComponent(ctx.params[0]));
    const { season, stype, week } = periodFilter(ctx.query);
    if (season == null || stype == null || week == null) throw bad('season, stype and week required');
    const rows = q(`SELECT g.*, p.home_pick, p.away_pick FROM games g JOIN picks p ON p.game_id = g.id AND p.user_id = ?
      WHERE g.season=? AND g.stype=? AND g.week=? ORDER BY g.kickoff, g.id`).all(target.id, season, stype, week);
    const self = ctx.user?.id === target.id;
    const games = rows.filter((g) => self || locked(g)).map((g) => gameView(g, g));
    return { user: target.username, games, week: S.summarize(games.filter((v) => v.result).map((v) => ({ s: v.result }))) };
  });

  function streaks(rows) {
    const sorted = [...rows].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    let cur = 0, best = 0;
    for (const r of sorted) { cur = r.s.correct ? cur + 1 : 0; best = Math.max(best, cur); }
    return { current: cur, longest: best };
  }

  route('GET', '/api/users/([^/]+)/stats', (ctx) => {
    const target = findUser(decodeURIComponent(ctx.params[0]));
    const season = intParam(ctx.query.get('season'));
    const rows = S.loadScored(db, { userId: target.id, season });
    const weeks = S.weekEntries(rows, db).sort((a, b) => S.periodOrder(a) - S.periodOrder(b));
    const seasons = S.seasonEntries(S.loadScored(db, { userId: target.id })).sort((a, b) => a.season - b.season);
    const key = ctx.query.get('by') || 'points';
    const minWeek = 5;
    const bw = S.bestWorst(weeks, key, minWeek);
    const bs = S.bestWorst(seasons, key, 1);
    const n = rows.length;
    return {
      user: target.username, joined: target.created_at, season: season ?? null,
      overall: {
        ...S.summarize(rows),
        avgPredMargin: n ? S.round(rows.reduce((a, r) => a + r.s.predMargin, 0) / n) : null,
        avgActualMargin: n ? S.round(rows.reduce((a, r) => a + r.s.actualMargin, 0) / n) : null,
        pickedHome: n ? S.round(rows.filter((r) => r.s.predMargin > 0).length / n * 100, 1) : null,
        actualHome: n ? S.round(rows.filter((r) => r.s.actualMargin > 0).length / n * 100, 1) : null,
        streak: streaks(rows),
      },
      bestWeek: bw.best, worstWeek: bw.worst, bestSeason: bs.best, worstSeason: bs.worst,
      bySeason: seasons, byWeek: weeks, byTeam: S.teamEntries(rows).sort((a, b) => b.games - a.games || a.team.localeCompare(b.team)),
    };
  });

  route('GET', '/api/leaderboard', (ctx) => {
    const { season, stype, week } = periodFilter(ctx.query);
    const sort = ctx.query.get('sort') || 'points';
    if (!SORT_KEYS.has(sort)) throw bad('Unknown sort');
    const min = intParam(ctx.query.get('min')) ?? 1;
    const rows = S.loadScored(db, { season, stype, week });
    return { leaderboard: S.leaderboard(rows, { sort, min }).slice(0, 200) };
  });

  // Every user-week ever played, ranked. Use ?order=best|worst&user=&season=&sort=
  route('GET', '/api/search/weeks', (ctx) => {
    const sort = ctx.query.get('sort') || 'points';
    const order = ctx.query.get('order') === 'worst' ? 'worst' : 'best';
    const minGames = intParam(ctx.query.get('minGames')) ?? 5;
    const rows = S.loadScored(db, { username: ctx.query.get('user') || undefined, season: intParam(ctx.query.get('season')) });
    const entries = S.weekEntries(rows, db).filter((e) => e.games >= minGames);
    return { results: rank(entries, sort, order).slice(0, limitParam(ctx.query.get('limit'))) };
  });

  route('GET', '/api/search/seasons', (ctx) => {
    const sort = ctx.query.get('sort') || 'points';
    const order = ctx.query.get('order') === 'worst' ? 'worst' : 'best';
    const minGames = intParam(ctx.query.get('minGames')) ?? 20;
    const rows = S.loadScored(db, { username: ctx.query.get('user') || undefined });
    const entries = S.seasonEntries(rows).filter((e) => e.games >= minGames);
    return { results: rank(entries, sort, order).slice(0, limitParam(ctx.query.get('limit'))) };
  });

  // Search individual picks on finished games: biggest misses, exact calls, upsets called, etc.
  route('GET', '/api/search/picks', (ctx) => {
    const result = ctx.query.get('result');
    const sort = ctx.query.get('sort') || 'recent';
    let rows = S.loadScored(db, {
      username: ctx.query.get('user') || undefined, season: intParam(ctx.query.get('season')),
      stype: intParam(ctx.query.get('stype')), week: intParam(ctx.query.get('week')), team: ctx.query.get('team') || undefined,
    });
    if (result === 'correct') rows = rows.filter((r) => r.s.correct);
    else if (result === 'wrong') rows = rows.filter((r) => !r.s.correct);
    else if (result === 'exact') rows = rows.filter((r) => r.s.exact);
    else if (result) throw bad('result must be correct, wrong or exact');
    const sorters = {
      recent: (a, b) => b.kickoff.localeCompare(a.kickoff),
      biggestMiss: (a, b) => b.s.marginErr - a.s.marginErr,
      closest: (a, b) => a.s.totalErr - b.s.totalErr || b.kickoff.localeCompare(a.kickoff),
      bestPoints: (a, b) => b.s.points - a.s.points || b.kickoff.localeCompare(a.kickoff),
      worstPoints: (a, b) => a.s.points - b.s.points || b.kickoff.localeCompare(a.kickoff),
      blowout: (a, b) => Math.abs(b.s.actualMargin) - Math.abs(a.s.actualMargin),
    };
    if (!sorters[sort]) throw bad(`sort must be one of ${Object.keys(sorters).join(', ')}`);
    rows.sort(sorters[sort]);
    return {
      total: rows.length,
      results: rows.slice(0, limitParam(ctx.query.get('limit'))).map((r) => ({ user: r.username, ...gameView(r, r) })),
    };
  });

  route('GET', '/api/search/users', (ctx) => {
    const term = (ctx.query.get('q') || '').replace(/[%_\\]/g, '');
    return { users: q(`SELECT username FROM users WHERE username LIKE ? ORDER BY username LIMIT 20`).all(`${term}%`) };
  });

  // Community-wide team view: who does everyone over/under-rate?
  route('GET', '/api/stats/teams', (ctx) => {
    const rows = S.loadScored(db, { season: intParam(ctx.query.get('season')), username: ctx.query.get('user') || undefined });
    return { teams: S.teamEntries(rows).sort((a, b) => b.bias - a.bias) };
  });

  // ---------- plumbing ----------
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100_000) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(bad('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' https://a.espncdn.com data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      let matched, params;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (m && r.method === req.method) { matched = r; params = m.slice(1); break; }
      }
      if (!matched) throw new HttpError(404, 'Not found');
      let body = {};
      if (req.method !== 'GET') {
        // Requiring JSON blocks cross-site form posts (a simple CSRF guard on top of SameSite=Lax cookies)
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send application/json');
        body = await readBody(req);
      }
      const ctx = { req, res, query: url.searchParams, params, body, user: sessionUser(req), ip: req.socket.remoteAddress };
      send(200, await matched.handler(ctx));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Server error' });
    }
  };

  return http.createServer(handler);
}

module.exports = { createApp, hashPassword, verifyPassword };
