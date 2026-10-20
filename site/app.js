// NFL score picks: pages and routing. Data access is in api.js, scoring in scoring.js.
//   /                         my picks for the current (or chosen) week
//   /me, /u/<handle>          history and stats for a player (add /<season> for one season)
//   /me/<season>/<stype>/<week>, /u/<handle>/<season>/<stype>/<week>   one week's picks
//   /leaderboard  /search  /teams
import { requireLogin, hasAccess, signOut, HOME, loadProfile } from './session.js';
import * as api from './api.js';
import { scorePick, leading, WINNER, MARGIN_MAX, EXACT } from './scoring.js';
import { $, el, weekLabel, periodKey, pct, num, fmtTime, logo, toast, select, stat, table, totals, finish } from './ui.js';

const SLUG = 'picks';
let liveTimer; // refreshes the cards of games in progress

const session = await requireLogin();
if (!(await hasAccess(SLUG))) {
  location.replace(HOME);
  await new Promise(() => {});
}

const me = { id: session.user.id, handle: null, name: (session.user.email ?? '').split('@')[0] || 'You' };
$('app').hidden = false;
$('signout').onclick = signOut;
$('home-link').href = HOME;
{
  const profile = await loadProfile(me.id);
  if (profile?.handle) me.handle = profile.handle;
  if (profile?.display_name || profile?.handle) me.name = profile.display_name || `@${profile.handle}`;
  $('handle').textContent = me.handle ? `@${me.handle}` : me.name;
}

// ---- routing --------------------------------------------------------------------------------

const link = (href, ...kids) => el('a', { href }, ...kids);
const personHref = (t, tail = '') => (t.id === me.id ? `/me${tail}` : `/u/${t.handle}${tail}`);

function go(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
const query = () => new URLSearchParams(location.search);
const setQuery = (changes) => {
  const q = query();
  for (const [k, v] of Object.entries(changes)) (v === '' || v == null ? q.delete(k) : q.set(k, v));
  go(`${location.pathname}${q.size ? `?${q}` : ''}`, { replace: true });
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  go(url.pathname + url.search);
});
addEventListener('popstate', render);

const NAV = [['/', 'Picks'], ['/me', 'History'], ['/leaderboard', 'Leaderboard'], ['/search', 'Search'], ['/teams', 'Teams']];
function drawNav() {
  const here = location.pathname;
  const active = (p) => (p === '/' ? here === '/' || /^\/me\/\d/.test(here) : here === p || here.startsWith(`${p}/`));
  $('nav').replaceChildren(...NAV.map(([p, label]) => el('a', { className: `btn${active(p) ? ' nav-active' : ''}`, href: p }, label)));
}

const view = (...nodes) => $('view').replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
const heading = (eyebrow, title, right) =>
  el('section', { className: 'hero' },
    el('div', {}, el('p', { className: 'eyebrow' }, el('span', { className: 'dot' }), eyebrow), el('h1', {}, title)),
    right);
const failed = (e) => view(el('section', { className: 'panel' }, el('h2', {}, 'Something went wrong'), el('p', { className: 'muted' }, e.message)));

async function render() {
  clearInterval(liveTimer);
  drawNav();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    const [first, a, b, c, d] = parts;
    if (!first) return await weekPage(me, weekFromQuery());
    if (first === 'me' || first === 'u') {
      const target = first === 'me' ? me : await resolveHandle(a);
      if (!target) return view(el('section', { className: 'panel' }, el('h2', {}, 'Player not found'), el('p', {}, link('/leaderboard', 'See the leaderboard'))));
      const rest = first === 'me' ? [a, b, c] : [b, c, d];
      if (rest[2] != null) return await weekPage(target, { season: +rest[0], stype: +rest[1], week: +rest[2] });
      return await profilePage(target, rest[0] ? +rest[0] : null);
    }
    if (first === 'leaderboard') return await leaderboardPage();
    if (first === 'search') return await searchPage();
    if (first === 'teams') return await teamsPage();
    view(el('section', { className: 'panel' }, el('h2', {}, 'Page not found'), el('p', {}, link('/', 'Back to picks'))));
  } catch (e) {
    console.error(e);
    failed(e);
  }
  window.scrollTo(0, 0);
}

async function resolveHandle(handle) {
  const p = await api.profileByHandle(handle);
  if (!p) return null;
  return p.user_id === me.id ? me : { id: p.user_id, handle: p.handle, name: p.display_name || `@${p.handle}` };
}

function weekFromQuery() {
  const q = query();
  return { season: +q.get('season') || null, stype: +q.get('stype') || null, week: +q.get('week') || null };
}

// ---- game cards -----------------------------------------------------------------------------

/**
 * One game. `game` is a picks.games row; `pick` {home_pick, away_pick} or null.
 * With `inputs` the card has score boxes, and registers its fields there.
 */
function gameCard(game, pick, { inputs, who, state, mine } = {}) {
  const result = pick ? scorePick(pick, game) : null;
  const final = game.status === 'final';
  const live = game.status === 'live';
  const shows = final || live; // the real score is on the card
  const ahead = pick ? leading(pick, game) : null;
  const t = (side) => ({ abbr: game[side], name: game[`${side}_name`], logo: game[`${side}_logo`], score: game[`${side}_score`] });

  const row = (side, other) => {
    const x = t(side), y = t(other);
    let control = null;
    if (inputs) {
      const input = el('input', {
        type: 'number', min: 0, max: 99, inputMode: 'numeric', className: 'score-in', ariaLabel: `${x.name} predicted score`,
        value: pick ? pick[`${side}_pick`] : '',
      });
      (inputs[game.id] ??= {})[side] = input;
      control = input;
    } else if (pick) control = el('span', { className: 'pickread', title: 'Pick' }, pick[`${side}_pick`]);
    return el('div', { className: `team${shows && x.score > y.score ? ' win' : ''}` },
      logo(x.logo), el('span', { className: 'abbr' }, x.abbr),
      live && game.possession === x.abbr && el('span', { className: 'ball', title: 'Has the ball' }, '🏈'),
      el('span', { className: 'tname' }, x.name),
      shows ? el('span', { className: 'real' }, x.score) : null, control);
  };

  // what is happening in a live game: clock, who has the ball, down and distance, field position
  const situation = live && game.possession && [
    game.possession && `${game.possession} ball`,
    game.down_distance && `${game.down_distance}${game.field_pos ? ` at ${game.field_pos}` : ''}`,
    game.red_zone && 'Red zone',
  ].filter(Boolean).join(' · ');

  const cardState = state ?? (live ? 'live' : result ? (result.correct ? 'right' : 'wrong') : inputs ? 'open' : '');
  const card = el('li', { className: 'game' },
    el('div', {},
      shows && pick && el('div', { className: 'cols' }, el('span', {}, 'Score'), el('span', {}, 'Pick')),
      row('away', 'home'), row('home', 'away')),
    live && el('div', { className: 'sit' },
      el('span', { className: 'pill live' }, el('i', { className: 'livedot' }), 'Live'),
      el('b', {}, game.detail ?? ''), situation && el('span', {}, situation)),
    el('div', { className: 'meta' },
      who,
      el('span', {}, fmtTime(game.kickoff)),
      live && pick && el('span', { className: ahead ? 'good' : 'bad' }, ahead ? 'Your pick is ahead' : 'Your pick is behind'),
      result && el('span', { className: `pill`, style: `--c: var(--${result.correct ? 'good' : 'bad'})` }, result.correct ? 'Right winner' : 'Wrong winner'),
      result && el('span', {}, `${result.points} pts`),
      result && el('span', {}, result.exact ? 'Exact score 🎯' : `margin off by ${result.marginErr}, total off by ${result.totalErr}`),
      !pick && !inputs && (final || mine ? (final ? el('span', {}, 'No pick') : null) : el('span', {}, new Date(game.kickoff) > Date.now() ? 'Pick hidden until kickoff' : 'No pick'))));
  card.dataset.state = cardState;
  return card;
}

// ---- week page (my picks, or someone's picks for a week) -------------------------------------

function periodPicker(ps, sel, onPick) {
  const seasons = api.seasonsOf(ps);
  const inSeason = ps.filter((p) => p.season === sel.season);
  return el('div', { className: 'row filters' },
    select('Season', seasons.map((s) => [s, s]), sel.season, (s) => {
      const list = ps.filter((p) => p.season === +s);
      const pick = (api.currentPeriod(list) ?? list[0]);
      onPick(pick);
    }),
    select('Week', inSeason.map((p) => [periodKey(p), weekLabel(p.stype, p.week) + (p.open ? '' : ' 🔒')]), `${sel.stype}-${sel.week}`, (v) => {
      const [stype, week] = v.split('-').map(Number);
      onPick(inSeason.find((p) => p.stype === stype && p.week === week));
    }));
}

async function weekPage(target, sel) {
  const ps = await api.periods();
  if (!ps.length) return view(heading('NFL Picks', 'No games yet'), el('p', { className: 'muted' }, 'The schedule has not been loaded yet. Check back soon.'));
  if (!sel.season || !sel.stype || !sel.week) {
    const cur = api.currentPeriod(ps);
    sel = { season: cur.season, stype: cur.stype, week: cur.week };
  }
  const period = ps.find((p) => p.season === sel.season && p.stype === sel.stype && p.week === sel.week);
  if (!period) return view(heading('NFL Picks', 'No such week'), el('p', {}, link('/', 'Back to picks')));

  const mine = target.id === me.id;
  const href = (p) => (mine ? `/?season=${p.season}&stype=${p.stype}&week=${p.week}` : personHref(target, `/${p.season}/${p.stype}/${p.week}`));
  const picker = periodPicker(ps, sel, (p) => go(href(p)));

  const games = await api.weekGames(sel);
  const picks = new Map((await api.picksFor(target.id, games.map((g) => g.id))).map((p) => [p.game_id, p]));
  const open = (g) => mine && period.open && g.status !== 'final' && new Date(g.kickoff) > Date.now();
  const anyOpen = games.some(open);

  // week summary from the finished games
  const scored = games.map((g) => picks.has(g.id) ? scorePick(picks.get(g.id), g) : null).filter(Boolean);
  const sum = totals(scored.map((r) => ({ games: 1, correct: +r.correct, exact: +r.exact, points: r.points, margin_err_sum: r.marginErr, total_err_sum: r.totalErr })));

  const inputs = {};
  const cardOf = (g) => gameCard(g, picks.get(g.id), { inputs: open(g) ? inputs : null, mine });
  const cards = new Map(games.map((g) => [g.id, cardOf(g)]));
  const save = el('button', { type: 'button', className: 'btn primary', textContent: 'Save picks' });
  save.onclick = async () => {
    const toSave = [], toClear = [];
    try {
      for (const g of games.filter(open)) {
        const f = inputs[g.id];
        const h = f.home.value.trim(), a = f.away.value.trim();
        if (h === '' && a === '') { if (picks.has(g.id)) toClear.push(g.id); continue; }
        if (h === '' || a === '') throw new Error(`Enter both scores for ${g.away} @ ${g.home}`);
        const hi = Number(h), ai = Number(a);
        if (![hi, ai].every((n) => Number.isInteger(n) && n >= 0 && n <= 99)) throw new Error('Scores are whole numbers from 0 to 99');
        const old = picks.get(g.id);
        if (!old || old.home_pick !== hi || old.away_pick !== ai) toSave.push({ game_id: g.id, home_pick: hi, away_pick: ai });
      }
      if (!toSave.length && !toClear.length) return toast('Nothing changed');
      save.disabled = true;
      await api.savePicks(me.id, toSave);
      await api.clearPicks(me.id, toClear);
      toast(`Saved ${toSave.length + toClear.length} change${toSave.length + toClear.length === 1 ? '' : 's'}`);
      await weekPage(target, sel);
    } catch (e) {
      toast(e.message.includes('row-level security') ? 'That game has already kicked off or its week is not open' : e.message, true);
      save.disabled = false;
    }
  };

  const heroRight = scored.length
    ? el('div', { className: 'statpanel' },
        cell('Points', sum.points), cell('Right', `${sum.correct}/${sum.games}`), cell('Exact', sum.exact), cell('Margin err', num(sum.avgMarginErr)))
    : null;

  const earlier = period.open ? null : firstBlocker(ps, period);
  view(
    heading(mine ? 'My picks' : target.name, `${weekLabel(period.stype, period.week)} · ${period.season}`, heroRight),
    picker,
    !mine && el('p', {}, link(personHref(target), `← ${target.name}'s history`)),
    !period.open && el('section', { className: 'panel notice' },
      el('span', {}, '🔒'),
      el('span', {}, earlier ? `Picks for this week open after ${weekLabel(earlier.stype, earlier.week)} ${earlier.season} ends.` : 'Picks for this week are not open yet.')),
    games.length
      ? el('ul', { className: 'games' }, [...cards.values()])
      : el('p', { className: 'empty' }, 'No games in this week.'),
    mine && anyOpen && el('div', { className: 'savebar' }, save,
      el('span', { className: 'muted' }, `Games lock at kickoff, and other players only see your pick after that. Max ${WINNER + MARGIN_MAX + EXACT} points per game.`)));
  watchLive(games, cards, sel, cardOf);
}

/** While a game in this week is in progress, swap in fresh cards as its score and situation change. */
function watchLive(games, cards, sel, cardOf) {
  const sig = (g) => [g.status, g.home_score, g.away_score, g.detail, g.possession, g.down_distance, g.field_pos].join('|');
  const active = (g) => g.status === 'live' || (g.status === 'scheduled' && new Date(g.kickoff) <= Date.now());
  if (!games.some(active)) return;
  const known = new Map(games.map((g) => [g.id, sig(g)]));
  liveTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const fresh = await api.weekGames(sel);
      for (const g of fresh) {
        if (known.get(g.id) === sig(g)) continue;
        known.set(g.id, sig(g));
        const next = cardOf(g);
        cards.get(g.id)?.replaceWith(next);
        cards.set(g.id, next);
      }
      if (!fresh.some(active)) clearInterval(liveTimer);
    } catch {
      // keep what is on screen; the next tick tries again
    }
  }, 20_000);
}

const cell = (label, value) => el('div', { className: 'stat-cell' }, el('span', { className: 'stat-label' }, label), el('span', { className: 'stat-value' }, String(value)));

function firstBlocker(ps, period) {
  const i = ps.indexOf(period);
  return ps.slice(0, i).find((p) => !p.ended) ?? null;
}

// ---- profile / history ----------------------------------------------------------------------

async function profilePage(target, season) {
  const [allSeasons, weeks, teamRows, streak] = await Promise.all([
    api.seasonScores({ userId: target.id }),
    api.weekScores({ userId: target.id, season }),
    api.teamStats({ userId: target.id, season }),
    api.streak(target.id),
  ]);
  const seasonRows = allSeasons.sort((a, b) => b.season - a.season);
  const rows = season ? seasonRows.filter((r) => r.season === season) : seasonRows;
  const o = totals(rows);
  const base = personHref(target);

  const seasonSelect = select('Season', [['', 'All seasons'], ...seasonRows.map((r) => [r.season, r.season])], season ?? '', (v) => go(v ? `${base}/${v}` : base));
  if (!o.games) {
    return view(heading(target === me ? `You${me.handle ? ` · @${me.handle}` : ''}` : `@${target.handle}`, target.name),
      el('section', { className: 'panel' }, el('p', { className: 'muted' }, target === me ? 'Your history appears here once games you picked are final.' : 'No finished picks yet.'),
        target === me && el('p', {}, link('/', 'Make this week\'s picks'))));
  }

  const eligible = weeks.filter((w) => w.games >= 5);
  const byPoints = [...eligible].sort((a, b) => b.points - a.points);
  const weekLink = (w) => w ? link(`${personHref(target)}/${w.season}/${w.stype}/${w.week}`, `${w.points} pts · ${weekLabel(w.stype, w.week)} ${w.season}`) : '–';
  const bestSeason = [...seasonRows].sort((a, b) => b.points - a.points)[0];
  const worstSeason = [...seasonRows].sort((a, b) => a.points - b.points)[0];

  view(
    heading(target === me ? `You${me.handle ? ` · @${me.handle}` : ''}` : `@${target.handle}`, target.name),
    el('div', { className: 'row filters' }, seasonSelect),
    el('div', { className: 'tiles' },
      stat('Total points', o.points), stat('Winners right', `${o.correct}/${o.games} (${pct(o.pct)})`),
      stat('Avg points / game', num(o.avgPoints, 2)), stat('Exact scores', o.exact),
      stat('Avg margin error', num(o.avgMarginErr)), stat('Avg total-score error', num(o.avgTotalErr)),
      stat('Longest streak', `${streak.longest} (now ${streak.current})`)),
    el('div', { className: 'tiles' },
      stat('Best week (5+ games)', weekLink(byPoints[0]), true), stat('Worst week (5+ games)', weekLink(byPoints[byPoints.length - 1]), true),
      stat('Best season', bestSeason ? `${bestSeason.points} pts · ${bestSeason.season}` : '–', true),
      stat('Worst season', worstSeason ? `${worstSeason.points} pts · ${worstSeason.season}` : '–', true)),
    el('h2', { className: 'section' }, 'Seasons'),
    table([
      { label: 'Season', val: (r) => r.season, num: false }, { label: 'Games', val: (r) => r.games, num: true },
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Avg pts', val: (r) => +r.avg_points, cell: (r) => num(r.avg_points, 2), num: true },
      { label: 'Right %', val: (r) => +r.pct, cell: (r) => pct(r.pct), num: true }, { label: 'Exact', val: (r) => r.exact, num: true },
      { label: 'Margin err', val: (r) => +r.avg_margin_err, cell: (r) => num(r.avg_margin_err), num: true },
    ], seasonRows, { sortCol: 0, onRow: (r) => go(`${base}/${r.season}`) }),
    el('h2', { className: 'section' }, `Weeks${season ? ` · ${season}` : ''}`),
    table([
      { label: 'Season', val: (r) => r.season, num: false },
      { label: 'Week', val: (r) => r.stype * 100 + r.week, cell: (r) => weekLabel(r.stype, r.week), num: false },
      { label: 'Picked', val: (r) => r.games, cell: (r) => `${r.games}/${r.games_in_week}`, num: true },
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Right', val: (r) => r.correct, cell: (r) => `${r.correct}/${r.games}`, num: true },
      { label: 'Exact', val: (r) => r.exact, num: true }, { label: 'Margin err', val: (r) => +r.avg_margin_err, cell: (r) => num(r.avg_margin_err), num: true },
    ], weeks, { sortCol: 3, onRow: (r) => go(`${base}/${r.season}/${r.stype}/${r.week}`) }),
    el('h2', { className: 'section' }, 'By team (games involving the team)'),
    teamTable(teamRows));
}

// ---- teams ----------------------------------------------------------------------------------

/** Combines team_stats rows (per player and season) into one row per team. */
function byTeam(rows) {
  const m = new Map();
  for (const r of rows) {
    const t = m.get(r.team) ?? { team: r.team, name: r.team_name, logo: r.team_logo, games: 0, correct: 0, exact: 0, points: 0, margin_err_sum: 0, total_err_sum: 0, picked_win: 0, actual_win: 0, pred_for: 0, actual_for: 0 };
    for (const k of Object.keys(t)) if (typeof t[k] === 'number') t[k] += Number(r[k] ?? 0);
    m.set(r.team, t);
  }
  return [...m.values()].map((t) => {
    const f = finish(t);
    return {
      ...f,
      pickedWin: (100 * t.picked_win) / t.games, actualWin: (100 * t.actual_win) / t.games,
      bias: (100 * (t.picked_win - t.actual_win)) / t.games,
      predPts: t.pred_for / t.games, actualPts: t.actual_for / t.games,
    };
  });
}

function teamTable(rows, sortCol = 1) {
  return table([
    { label: 'Team', val: (r) => r.team, cell: (r) => el('span', { className: 'team' }, logo(r.logo), r.team), num: false },
    { label: 'Games', val: (r) => r.games, num: true }, { label: 'Right %', val: (r) => r.pct, cell: (r) => pct(r.pct), num: true },
    { label: 'Avg pts', val: (r) => r.avgPoints, cell: (r) => num(r.avgPoints, 2), num: true },
    { label: 'Margin err', val: (r) => r.avgMarginErr, cell: (r) => num(r.avgMarginErr), num: true },
    { label: 'Picked to win', val: (r) => r.pickedWin, cell: (r) => pct(r.pickedWin), num: true },
    { label: 'Actually won', val: (r) => r.actualWin, cell: (r) => pct(r.actualWin), num: true },
    { label: 'Overrated', title: 'Picked-to-win % minus actual win %. Positive = overrated, negative = underrated', val: (r) => r.bias,
      cell: (r) => el('span', { className: r.bias > 0 ? 'warn' : r.bias < 0 ? 'good' : '' }, `${r.bias > 0 ? '+' : ''}${r.bias.toFixed(1)}`), num: true },
    { label: 'Pred pts', title: 'Average points predicted for this team', val: (r) => r.predPts, cell: (r) => num(r.predPts), num: true },
    { label: 'Real pts', title: 'Average points this team really scored', val: (r) => r.actualPts, cell: (r) => num(r.actualPts), num: true },
  ], byTeam(rows), { sortCol });
}

async function teamsPage() {
  const ps = await api.periods();
  const q = query();
  const season = +q.get('season') || null;
  const rows = await api.teamStats({ season });
  view(
    heading('Everyone', 'Teams: who do we get wrong?'),
    el('p', { className: 'muted' }, 'Every pick from every player. "Overrated" means picked to win more often than the team really won. Click a column to re-sort.'),
    el('div', { className: 'row filters' }, select('Season', [['', 'All seasons'], ...api.seasonsOf(ps).map((s) => [s, s])], season ?? '', (v) => setQuery({ season: v }))),
    teamTable(rows, 7));
}

// ---- leaderboard ----------------------------------------------------------------------------

async function leaderboardPage() {
  const ps = await api.periods();
  const q = query();
  const scope = q.get('scope') || 'alltime';
  const seasons = api.seasonsOf(ps);
  const season = +q.get('season') || seasons[0] || null;
  const sort = q.get('sort') || 'points';
  const min = +q.get('min') || 1;
  const inSeason = ps.filter((p) => p.season === season);
  const cur = api.currentPeriod(inSeason);
  const periodSel = q.get('period') ?? (cur ? periodKey(cur) : '');
  const [stype, week] = periodSel.split('-').map(Number);

  let rows;
  if (scope === 'week') rows = week ? await api.weekScoresFor({ season, stype, week }) : [];
  else rows = await api.seasonScores({ season: scope === 'season' ? season : null });

  const board = [...Map.groupBy(rows, (r) => r.user_id).values()].map((g) => ({ user_id: g[0].user_id, name: g[0].name, handle: g[0].handle, ...totals(g) }))
    .filter((r) => r.games >= min);
  const cmp = { points: (a, b) => b.points - a.points, avgPoints: (a, b) => b.avgPoints - a.avgPoints, pct: (a, b) => b.pct - a.pct,
    avgMarginErr: (a, b) => a.avgMarginErr - b.avgMarginErr, exact: (a, b) => b.exact - a.exact }[sort] ?? ((a, b) => b.points - a.points);
  board.sort((a, b) => cmp(a, b) || b.points - a.points || a.avgMarginErr - b.avgMarginErr || a.name.localeCompare(b.name));
  board.forEach((r, i) => { r.rank = i + 1; });

  view(
    heading('Everyone', 'Leaderboard'),
    el('div', { className: 'row filters' },
      select('Scope', [['alltime', 'All time'], ['season', 'Season'], ['week', 'Single week']], scope, (v) => setQuery({ scope: v })),
      scope !== 'alltime' && select('Season', seasons.map((s) => [s, s]), season, (v) => setQuery({ season: v, period: '' })),
      scope === 'week' && select('Week', inSeason.map((p) => [periodKey(p), weekLabel(p.stype, p.week)]), periodSel, (v) => setQuery({ period: v })),
      select('Rank by', [['points', 'Total points'], ['avgPoints', 'Avg points / game'], ['pct', 'Winner %'], ['avgMarginErr', 'Margin error'], ['exact', 'Exact scores']], sort, (v) => setQuery({ sort: v })),
      select('Min games', [[1, 'Any'], [10, '10+'], [50, '50+'], [200, '200+']], min, (v) => setQuery({ min: v }))),
    table([
      { label: '#', val: (r) => r.rank, num: true },
      { label: 'Player', val: (r) => r.name, cell: (r) => r.handle ? link(r.user_id === me.id ? '/me' : `/u/${r.handle}`, r.name) : r.name, num: false },
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Games', val: (r) => r.games, num: true },
      { label: 'Avg pts', val: (r) => r.avgPoints, cell: (r) => num(r.avgPoints, 2), num: true },
      { label: 'Right %', val: (r) => r.pct, cell: (r) => pct(r.pct), num: true },
      { label: 'Exact', val: (r) => r.exact, num: true },
      { label: 'Margin err', val: (r) => r.avgMarginErr, cell: (r) => num(r.avgMarginErr), num: true },
    ], board, { sortCol: 0, desc: false }));
}

// ---- search ---------------------------------------------------------------------------------

const RANK_COLUMNS = {
  points: ['points', false], pct: ['pct', false], avgPoints: ['avg_points', false], exact: ['exact', false],
  avgMarginErr: ['avg_margin_err', true], avgTotalErr: ['avg_total_err', true],
};
const PICK_ORDERS = {
  biggestMiss: ['Biggest misses', { column: 'margin_err', ascending: false }],
  closest: ['Closest calls', { column: 'total_err', ascending: true }],
  bestPoints: ['Most points', { column: 'points', ascending: false }],
  worstPoints: ['Fewest points', { column: 'points', ascending: true }],
  blowout: ['Biggest blowouts', { column: 'blowout', ascending: false }],
  recent: ['Most recent', { column: 'kickoff', ascending: false }],
};

async function searchPage() {
  const ps = await api.periods();
  const q = query();
  const tab = q.get('tab') || 'weeks';
  const f = {
    order: q.get('order') || 'best', sort: q.get('sort') || 'points', player: (q.get('player') || '').trim().replace(/^@/, ''),
    season: +q.get('season') || null, team: q.get('team') || '', result: q.get('result') || '', psort: q.get('psort') || 'biggestMiss',
  };
  const tabs = el('div', { className: 'row filters' }, [['weeks', 'Best / worst weeks'], ['seasons', 'Best / worst seasons'], ['picks', 'Pick explorer']]
    .map(([t, label]) => el('button', { type: 'button', className: `btn${t === tab ? ' nav-active' : ''}`, onclick: () => setQuery({ tab: t }) }, label)));
  const player = el('label', { className: 'field' }, 'Player handle',
    el('input', { type: 'search', placeholder: 'any player', value: f.player, onchange: (e) => setQuery({ player: e.target.value.trim() }) }));
  const seasonSel = select('Season', [['', 'All seasons'], ...api.seasonsOf(ps).map((s) => [s, s])], f.season ?? '', (v) => setQuery({ season: v }));
  const orderSel = select('Show', [['best', 'Best'], ['worst', 'Worst']], f.order, (v) => setQuery({ order: v }));
  const sortSel = select('By', [['points', 'Points'], ['pct', 'Winner %'], ['avgPoints', 'Avg points / game'], ['avgMarginErr', 'Margin error'], ['avgTotalErr', 'Total-score error'], ['exact', 'Exact scores']], f.sort, (v) => setQuery({ sort: v }));

  let controls, results;
  if (tab === 'picks') {
    const teams = await api.teams();
    controls = [player, seasonSel,
      select('Team', [['', 'Any team'], ...teams.map((t) => [t.abbr, t.name])], f.team, (v) => setQuery({ team: v })),
      select('Result', [['', 'Any result'], ['correct', 'Right winner'], ['wrong', 'Wrong winner'], ['exact', 'Exact score']], f.result, (v) => setQuery({ result: v })),
      select('Sort', Object.entries(PICK_ORDERS).map(([k, [label]]) => [k, label]), f.psort, (v) => setQuery({ psort: v }))];
    const { rows, total } = await api.scoredPicks({ handle: f.player, season: f.season, team: f.team, result: f.result, order: (PICK_ORDERS[f.psort] ?? PICK_ORDERS.biggestMiss)[1] });
    results = [el('p', { className: 'muted' }, `${total} matching picks (showing up to 50)`),
      el('ul', { className: 'games' }, rows.map((r) => gameCard(
        { id: r.game_id, ...r, status: 'final' }, { home_pick: r.home_pick, away_pick: r.away_pick },
        { who: r.handle ? link(`/u/${r.handle}`, r.name) : el('span', {}, r.name) })))];
  } else {
    const [column, lowIsBest] = RANK_COLUMNS[f.sort] ?? RANK_COLUMNS.points;
    const weeks = tab === 'weeks';
    controls = weeks ? [orderSel, sortSel, player, seasonSel] : [orderSel, sortSel, player];
    const data = await api.ranked(weeks ? 'week_scores' : 'season_scores', {
      column, ascending: (f.order === 'best') === lowIsBest, minGames: weeks ? 5 : 20, handle: f.player, season: weeks ? f.season : null,
    });
    const who = (r) => (r.handle ? link(r.user_id === me.id ? '/me' : `/u/${r.handle}`, r.name) : r.name);
    const common = [
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Right', val: (r) => r.correct, cell: (r) => `${r.correct}/${r.games}`, num: true },
      { label: 'Exact', val: (r) => r.exact, num: true }, { label: 'Margin err', val: (r) => +r.avg_margin_err, cell: (r) => num(r.avg_margin_err), num: true },
    ];
    results = [
      el('p', { className: 'muted' }, weeks ? 'Weeks with at least 5 finished picks. Click a row to see the picks.' : 'Seasons with at least 20 finished picks. Click a row to open it.'),
      table([{ label: 'Player', val: (r) => r.name, cell: who, num: false }, { label: 'Season', val: (r) => r.season, num: false },
        ...(weeks ? [{ label: 'Week', val: (r) => r.stype * 100 + r.week, cell: (r) => weekLabel(r.stype, r.week), num: false }] : []), ...common], data,
      { onRow: (r) => r.handle && go(`${r.user_id === me.id ? '/me' : `/u/${r.handle}`}/${r.season}${weeks ? `/${r.stype}/${r.week}` : ''}`) })];
  }
  view(heading('Everyone', 'Search'), tabs, el('div', { className: 'row filters' }, controls), results);
}

// ---- start ----------------------------------------------------------------------------------

render();
