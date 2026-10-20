'use strict';
/* Single-page app: hash routes, no build step. All DOM is built with h() so user text is never parsed as HTML. */

const $view = document.getElementById('view');
/** Replace the page content; accepts nested arrays and skips null/false. */
const show = (...nodes) => $view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
const state = { me: null, scoring: null, seasons: [], teams: [] };

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2500);
}

const POST_NAMES = { 1: 'Wild Card', 2: 'Divisional', 3: 'Conference', 5: 'Super Bowl' };
const weekLabel = (stype, week) => (stype === 3 ? POST_NAMES[week] || `Playoffs ${week}` : `Week ${week}`);
const pct = (n) => (n == null ? '–' : `${n}%`);
const num = (n, d = 1) => (n == null ? '–' : Number(n).toFixed(d));
const fmtTime = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const userLink = (name) => h('a', { href: `#/u/${encodeURIComponent(name)}` }, name);
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

function select(options, value, onchange, label) {
  const sel = h('select', { onchange: (e) => onchange(e.target.value) },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
  return label ? h('label', {}, label, sel) : sel;
}

/** Sortable table. cols: {label, val(row) -> sortable/plain value, cell?(row) -> node, num?} */
function table(cols, rows, { onRow, sortCol = null, desc = true } = {}) {
  let sc = sortCol, sd = desc;
  const wrap = h('div', { class: 'table-wrap' });
  const draw = () => {
    const data = [...rows];
    if (sc != null) {
      const c = cols[sc];
      data.sort((a, b) => {
        const x = c.val(a), y = c.val(b);
        const r = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? -Infinity) - (y ?? -Infinity);
        return sd ? -r : r;
      });
    }
    wrap.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', {
        class: `sortable ${c.num ? 'num' : ''}`, title: c.title || '',
        onclick: () => { if (sc === i) sd = !sd; else { sc = i; sd = c.num !== false; } draw(); },
      }, c.label, sc === i ? (sd ? ' ▼' : ' ▲') : '')))),
      h('tbody', {}, data.map((row) => h('tr', { class: onRow ? 'click' : '', onclick: onRow && (() => onRow(row)) },
        cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.cell ? c.cell(row) : (c.val(row) ?? '–'))))))));
  };
  draw();
  return rows.length ? wrap : h('p', { class: 'muted' }, 'Nothing to show yet.');
}

function tile(value, label) { return h('div', { class: 'tile' }, h('b', {}, value), h('span', {}, label)); }

// ---------- account ----------
function renderChrome() {
  const here = location.hash.slice(2).split('/')[0] || 'picks';
  const links = [['picks', 'My picks'], ['leaderboard', 'Leaderboard'], ['search', 'Search'], ['teams', 'Teams']];
  if (state.me) links.splice(1, 0, [`u/${encodeURIComponent(state.me.username)}`, 'My history']);
  document.getElementById('nav').replaceChildren(...links.map(([p, t]) =>
    h('a', { href: `#/${p}`, class: here === p.split('/')[0] && (p.startsWith('u/') ? location.hash.includes(p) : true) ? 'on' : '' }, t)));
  document.getElementById('account').replaceChildren(state.me
    ? h('span', {}, h('b', {}, state.me.username), ' ', h('button', { onclick: async () => { await api('/logout', { method: 'POST', body: {} }); state.me = null; route(); } }, 'Log out'))
    : h('a', { href: '#/login' }, 'Log in / Sign up'));
}

function viewLogin() {
  const err = h('div', { class: 'err' });
  const user = h('input', { placeholder: 'Username', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password', required: true });
  const go = async (kind) => {
    err.textContent = '';
    try {
      const r = await api(`/${kind}`, { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      state.me = { username: r.username };
      location.hash = '#/picks';
    } catch (e) { err.textContent = e.message; }
  };
  show(h('form', { class: 'card auth', onsubmit: (e) => { e.preventDefault(); go('login'); } },
    h('h1', {}, 'Welcome'), user, pass, err,
    h('button', { class: 'primary', type: 'submit' }, 'Log in'),
    h('button', { type: 'button', onclick: () => go('register') }, 'Create account'),
    h('p', { class: 'muted' }, 'Your picks are kept forever, season after season.')));
}

// ---------- game cards ----------
function teamRow(g, side, editable, inputs) {
  const t = g[side], other = g[side === 'home' ? 'away' : 'home'];
  const winner = g.status === 'final' && t.score > other.score;
  let ctl = null;
  if (editable) {
    const input = h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', class: 'pi', 'aria-label': `${t.name} predicted score`, value: g.pick ? g.pick[side] : '' });
    inputs[side] = input;
    ctl = input;
  } else if (g.pick) ctl = h('span', { class: 'pickread', title: 'Pick' }, g.pick[side]);
  return h('div', { class: `team ${winner ? 'win' : ''}` },
    t.logo ? h('img', { src: t.logo, alt: '', loading: 'lazy' }) : null,
    h('span', { class: 'abbr' }, t.abbr), h('span', { class: 'muted' }, t.name),
    g.status === 'final' ? h('span', { class: 'real' }, t.score) : null,
    ctl);
}

function gameCard(g, { editable, collect, showUser }) {
  const inputs = {};
  const r = g.result;
  const meta = [
    showUser ? userLink(showUser) : null,
    h('span', {}, fmtTime(g.kickoff)),
    h('span', {}, `${weekLabel(g.stype, g.week)} ${g.season}`),
    r ? h('span', { class: r.correct ? 'good' : 'bad' }, r.correct ? '✓ right winner' : '✗ wrong winner') : null,
    r ? h('span', {}, `${r.points} pts`) : null,
    r ? h('span', { class: 'muted' }, r.exact ? 'exact score! 🎯' : `margin off by ${r.marginErr}, total off by ${r.totalErr}`) : null,
    !editable && !g.pick ? h('span', { class: 'muted' }, 'no pick') : null,
    !g.locked && !editable ? h('span', { class: 'badge' }, 'open') : null,
  ];
  const card = h('div', { class: 'card game' },
    h('div', { class: 'teams' }, teamRow(g, 'away', editable, inputs), teamRow(g, 'home', editable, inputs)),
    h('div', { class: 'meta' }, meta));
  if (editable) collect.push(() => {
    const home = inputs.home.value, away = inputs.away.value;
    if (home === '' && away === '') return null;
    if (home === '' || away === '') throw new Error(`Enter both scores for ${g.away.abbr} @ ${g.home.abbr}`);
    return { gameId: g.id, home: Number(home), away: Number(away) };
  });
  return card;
}

function weekSummary(w) {
  if (!w || !w.games) return null;
  return h('div', { class: 'tiles' }, tile(w.points, 'points'), tile(`${w.correct}/${w.games}`, 'winners right'),
    tile(w.exact, 'exact scores'), tile(num(w.avgMarginErr), 'avg margin error'));
}

// ---------- period picker shared by picks + history ----------
async function periodPicker({ season, stype, week }, onChange) {
  if (!state.seasons.length) state.seasons = (await api('/seasons')).seasons;
  if (!state.seasons.length) return { node: h('p', { class: 'muted' }, 'No games loaded yet. Run `npm run sync` on the server.'), empty: true };
  season = season ?? state.seasons[0].season;
  const { periods, current } = await api(`/periods?season=${season}`);
  if (stype == null || week == null) ({ stype, week } = current || periods[0] || {});
  const key = (p) => `${p.stype}-${p.week}`;
  const node = h('div', { class: 'row' },
    select(state.seasons.map((s) => [s.season, s.season]), season, (v) => onChange({ season: Number(v) }), 'Season'),
    select(periods.map((p) => [key(p), weekLabel(p.stype, p.week)]), `${stype}-${week}`, (v) => {
      const [st, wk] = v.split('-').map(Number);
      onChange({ season, stype: st, week: wk });
    }, 'Week'));
  return { node, season, stype, week, periods };
}

// ---------- views ----------
async function viewPicks(params) {
  const p = await periodPicker({ season: params.season && +params.season, stype: params.stype && +params.stype, week: params.week && +params.week },
    (sel) => { location.hash = `#/picks${qs(sel)}`; });
  if (p.empty) return show(p.node);
  const { games, week } = await api(`/games${qs({ season: p.season, stype: p.stype, week: p.week })}`);
  const collect = [];
  const open = games.filter((g) => !g.locked).length;
  const save = h('button', { class: 'primary', onclick: async () => {
    try {
      const picks = collect.map((f) => f()).filter(Boolean);
      if (!picks.length) return toast('Enter at least one score');
      const r = await api('/picks', { method: 'PUT', body: { picks } });
      toast(`Saved ${r.saved.length} pick${r.saved.length === 1 ? '' : 's'}${r.rejected.length ? ` (${r.rejected.length} already locked)` : ''}`);
    } catch (e) { toast(e.message); }
  } }, 'Save picks');
  const cards = games.map((g) => gameCard(g, { editable: !g.locked && !!state.me, collect }));
  show(
    h('h1', {}, `${weekLabel(p.stype, p.week)} · ${p.season}`), p.node,
    !state.me ? h('p', { class: 'card' }, h('a', { href: '#/login' }, 'Log in'), ' to make picks. Games lock at kickoff.') : null,
    weekSummary(week),
    state.me && open ? h('div', { class: 'row' }, save, h('span', { class: 'muted' }, `${open} game${open === 1 ? '' : 's'} open. Locks at kickoff; others see your pick only after that.`)) : null,
    cards.length ? cards : h('p', { class: 'muted' }, 'No games in this week.'));
}

async function viewProfile(name, params) {
  const season = params.season ? +params.season : undefined;
  const s = await api(`/users/${encodeURIComponent(name)}/stats${qs({ season })}`);
  const o = s.overall;
  const seasonOpts = [['', 'All seasons'], ...s.bySeason.map((x) => [x.season, x.season])];
  const goWeek = (e) => { location.hash = `#/u/${encodeURIComponent(name)}/${e.season}/${e.stype}/${e.week}`; };
  const best = (e, text) => e ? h('a', { href: `#/u/${encodeURIComponent(name)}/${e.season}/${e.stype}/${e.week}` }, `${e.points} pts · ${weekLabel(e.stype, e.week)} ${e.season}`) : text;

  const nodes = [
    h('h1', {}, `${s.user}${state.me?.username === s.user ? ' (you)' : ''}`),
    h('div', { class: 'row' }, select(seasonOpts, season ?? '', (v) => { location.hash = `#/u/${encodeURIComponent(name)}${v ? '/' + v : ''}`; }, 'Season')),
  ];
  if (!o.games) {
    nodes.push(h('p', { class: 'card muted' }, 'No scored picks yet. Stats appear once games you picked are final.'));
    return show(...nodes);
  }
  nodes.push(
    h('div', { class: 'tiles' },
      tile(o.points, 'total points'), tile(`${o.correct}/${o.games}`, `winners right (${pct(o.pct)})`),
      tile(num(o.avgPoints), 'avg points / game'), tile(o.exact, 'exact scores'),
      tile(num(o.avgMarginErr), 'avg margin error'), tile(num(o.avgTotalErr), 'avg total-score error'),
      tile(o.streak.longest, `longest streak (now ${o.streak.current})`),
      tile(`${pct(o.pickedHome)} / ${pct(o.actualHome)}`, 'picked home wins / actual home wins')),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('span', {}, 'Best week (5+ games)'), h('div', {}, best(s.bestWeek, '–'))),
      h('div', { class: 'tile' }, h('span', {}, 'Worst week (5+ games)'), h('div', {}, best(s.worstWeek, '–'))),
      h('div', { class: 'tile' }, h('span', {}, 'Best season'), h('div', {}, s.bestSeason ? `${s.bestSeason.points} pts · ${s.bestSeason.season}` : '–')),
      h('div', { class: 'tile' }, h('span', {}, 'Worst season'), h('div', {}, s.worstSeason ? `${s.worstSeason.points} pts · ${s.worstSeason.season}` : '–'))),
    h('h2', {}, 'Seasons'),
    table([
      { label: 'Season', val: (r) => r.season, num: false }, { label: 'Games', val: (r) => r.games, num: true },
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Avg pts', val: (r) => r.avgPoints, cell: (r) => num(r.avgPoints, 2), num: true },
      { label: 'Right %', val: (r) => r.pct, cell: (r) => pct(r.pct), num: true }, { label: 'Exact', val: (r) => r.exact, num: true },
      { label: 'Margin err', val: (r) => r.avgMarginErr, cell: (r) => num(r.avgMarginErr), num: true },
    ], s.bySeason, { sortCol: 0, desc: true, onRow: (r) => { location.hash = `#/u/${encodeURIComponent(name)}/${r.season}`; } }),
    h('h2', {}, `Weeks${season ? ` · ${season}` : ''}`),
    table([
      { label: 'Season', val: (r) => r.season, num: false }, { label: 'Week', val: (r) => r.stype * 100 + r.week, cell: (r) => weekLabel(r.stype, r.week), num: false },
      { label: 'Picked', val: (r) => r.games, cell: (r) => `${r.games}/${r.gamesInWeek}`, num: true },
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Right', val: (r) => r.correct, cell: (r) => `${r.correct}/${r.games}`, num: true },
      { label: 'Exact', val: (r) => r.exact, num: true }, { label: 'Margin err', val: (r) => r.avgMarginErr, cell: (r) => num(r.avgMarginErr), num: true },
    ], s.byWeek, { sortCol: 3, desc: true, onRow: goWeek }),
    h('h2', {}, 'By team (games involving the team)'),
    teamTable(s.byTeam));
  show(...nodes);
}

function teamTable(teams, sortCol = 1) {
  return table([
    { label: 'Team', val: (r) => r.team, cell: (r) => h('span', { class: 'team' }, r.logo ? h('img', { src: r.logo, alt: '' }) : null, r.team), num: false },
    { label: 'Games', val: (r) => r.games, num: true }, { label: 'Right %', val: (r) => r.pct, cell: (r) => pct(r.pct), num: true },
    { label: 'Avg pts', val: (r) => r.avgPoints, cell: (r) => num(r.avgPoints, 2), num: true },
    { label: 'Margin err', val: (r) => r.avgMarginErr, cell: (r) => num(r.avgMarginErr), num: true },
    { label: 'Picked to win', val: (r) => r.pickedWinPct, cell: (r) => pct(r.pickedWinPct), num: true },
    { label: 'Actually won', val: (r) => r.actualWinPct, cell: (r) => pct(r.actualWinPct), num: true },
    { label: 'Overrated', title: 'Picked-to-win % minus actual win %. Positive = overrated, negative = underrated', val: (r) => r.bias, cell: (r) => h('span', { class: r.bias > 0 ? 'warn' : r.bias < 0 ? 'good' : '' }, `${r.bias > 0 ? '+' : ''}${r.bias}`), num: true },
    { label: 'Pred pts', title: 'Average points predicted for this team', val: (r) => r.avgPredPoints, num: true },
    { label: 'Real pts', title: 'Average points this team really scored', val: (r) => r.avgActualPoints, num: true },
  ], teams, { sortCol, desc: true });
}

async function viewUserWeek(name, season, stype, week) {
  const { games, week: w } = await api(`/users/${encodeURIComponent(name)}/picks${qs({ season, stype, week })}`);
  show(
    h('p', {}, h('a', { href: `#/u/${encodeURIComponent(name)}/${season}` }, `← ${name}'s ${season}`)),
    h('h1', {}, `${name} · ${weekLabel(+stype, +week)} ${season}`), weekSummary(w),
    games.length ? games.map((g) => gameCard(g, { editable: false })) : h('p', { class: 'muted' }, 'No visible picks. Picks are revealed to others at kickoff.'));
}

async function viewLeaderboard(params) {
  if (!state.seasons.length) state.seasons = (await api('/seasons')).seasons;
  const scope = params.scope || 'alltime';
  const sort = params.sort || 'points';
  const min = params.min || '1';
  const season = params.season || String(state.seasons[0]?.season ?? '');
  let weekSel = '';
  const query = { sort, min };
  if (scope !== 'alltime') query.season = season;
  if (scope === 'week') {
    const { periods, current } = await api(`/periods?season=${season}`);
    const cur = params.period || (current ? `${current.stype}-${current.week}` : '');
    const [st, wk] = cur.split('-');
    if (st) { query.stype = st; query.week = wk; }
    weekSel = select(periods.map((p) => [`${p.stype}-${p.week}`, weekLabel(p.stype, p.week)]), cur, (v) => go({ period: v }), 'Week');
  }
  function go(change) { location.hash = `#/leaderboard${qs({ scope, sort, min, season, ...change })}`; }
  const { leaderboard } = await api(`/leaderboard${qs(query)}`);
  show(
    h('h1', {}, 'Leaderboard'),
    h('div', { class: 'row' },
      select([['alltime', 'All time'], ['season', 'Season'], ['week', 'Single week']], scope, (v) => go({ scope: v }), 'Scope'),
      scope !== 'alltime' ? select(state.seasons.map((s) => [s.season, s.season]), season, (v) => go({ season: v, period: '' }), 'Season') : null,
      weekSel,
      select([['points', 'Total points'], ['avgPoints', 'Avg points / game'], ['pct', 'Winner %'], ['marginErr', 'Margin error'], ['exact', 'Exact scores']].map(([v, t]) => [v === 'marginErr' ? 'avgMarginErr' : v, t]), sort, (v) => go({ sort: v }), 'Rank by'),
      select([['1', 'Any'], ['10', '10+'], ['50', '50+'], ['200', '200+']], min, (v) => go({ min: v }), 'Min games')),
    table([
      { label: '#', val: (r) => r.rank, num: true }, { label: 'Player', val: (r) => r.user, cell: (r) => userLink(r.user), num: false },
      { label: 'Points', val: (r) => r.points, num: true }, { label: 'Games', val: (r) => r.games, num: true },
      { label: 'Avg pts', val: (r) => r.avgPoints, cell: (r) => num(r.avgPoints, 2), num: true },
      { label: 'Right %', val: (r) => r.pct, cell: (r) => pct(r.pct), num: true },
      { label: 'Exact', val: (r) => r.exact, num: true }, { label: 'Margin err', val: (r) => r.avgMarginErr, cell: (r) => num(r.avgMarginErr), num: true },
    ], leaderboard, { sortCol: 0, desc: false }));
}

async function viewSearch(params) {
  if (!state.seasons.length) state.seasons = (await api('/seasons')).seasons;
  if (!state.teams.length) state.teams = (await api('/teams')).teams;
  const tab = params.tab || 'weeks';
  const f = { order: params.order || 'best', sort: params.sort || 'points', user: params.user || '', season: params.season || '', team: params.team || '', result: params.result || '', psort: params.psort || 'biggestMiss' };
  const go = (change) => { location.hash = `#/search${qs({ tab, ...f, ...change })}`; };
  const seasonSel = select([['', 'All seasons'], ...state.seasons.map((s) => [s.season, s.season])], f.season, (v) => go({ season: v }), 'Season');
  const userInput = h('input', { placeholder: 'any player', value: f.user, onchange: (e) => go({ user: e.target.value.trim() }), size: 12 });
  const orderSel = select([['best', 'Best'], ['worst', 'Worst']], f.order, (v) => go({ order: v }), 'Show');
  const sortSel = select([['points', 'Points'], ['pct', 'Winner %'], ['avgPoints', 'Avg points / game'], ['avgMarginErr', 'Margin error'], ['avgTotalErr', 'Total-score error'], ['exact', 'Exact scores']], f.sort, (v) => go({ sort: v }), 'By');
  const tabs = h('div', { class: 'tabs' }, [['weeks', 'Best / worst weeks'], ['seasons', 'Best / worst seasons'], ['picks', 'Pick explorer']]
    .map(([t, label]) => h('button', { class: t === tab ? 'on' : '', onclick: () => go({ tab: t }) }, label)));
  const userLabel = h('label', {}, 'Player', userInput);
  let controls, results;

  if (tab === 'picks') {
    const teamSel = select([['', 'Any team'], ...state.teams.map((t) => [t.abbr, t.name])], f.team, (v) => go({ team: v }), 'Team');
    const resSel = select([['', 'Any result'], ['correct', 'Right winner'], ['wrong', 'Wrong winner'], ['exact', 'Exact score']], f.result, (v) => go({ result: v }), 'Result');
    const sortP = select([['biggestMiss', 'Biggest misses'], ['closest', 'Closest calls'], ['bestPoints', 'Most points'], ['worstPoints', 'Fewest points'], ['blowout', 'Biggest blowouts'], ['recent', 'Most recent']], f.psort, (v) => go({ psort: v }), 'Sort');
    controls = [userLabel, seasonSel, teamSel, resSel, sortP];
    const r = await api(`/search/picks${qs({ user: f.user, season: f.season, team: f.team, result: f.result, sort: f.psort, limit: 50 })}`);
    results = [h('p', { class: 'muted' }, `${r.total} matching picks (showing up to 50)`), r.results.map((g) => gameCard(g, { editable: false, showUser: g.user }))];
  } else if (tab === 'seasons') {
    controls = [orderSel, sortSel, userLabel];
    const r = await api(`/search/seasons${qs({ order: f.order, sort: f.sort, user: f.user, limit: 50 })}`);
    results = table([
      { label: 'Player', val: (x) => x.user, cell: (x) => userLink(x.user), num: false }, { label: 'Season', val: (x) => x.season, num: false },
      { label: 'Points', val: (x) => x.points, num: true }, { label: 'Games', val: (x) => x.games, num: true },
      { label: 'Avg pts', val: (x) => x.avgPoints, cell: (x) => num(x.avgPoints, 2), num: true }, { label: 'Right %', val: (x) => x.pct, cell: (x) => pct(x.pct), num: true },
      { label: 'Exact', val: (x) => x.exact, num: true }, { label: 'Margin err', val: (x) => x.avgMarginErr, cell: (x) => num(x.avgMarginErr), num: true },
    ], r.results, { onRow: (x) => { location.hash = `#/u/${encodeURIComponent(x.user)}/${x.season}`; } });
  } else {
    controls = [orderSel, sortSel, userLabel, seasonSel];
    const r = await api(`/search/weeks${qs({ order: f.order, sort: f.sort, user: f.user, season: f.season, limit: 50 })}`);
    results = [h('p', { class: 'muted' }, 'Weeks with at least 5 picks on finished games. Click a row to see the picks.'), table([
      { label: 'Player', val: (x) => x.user, cell: (x) => userLink(x.user), num: false }, { label: 'Season', val: (x) => x.season, num: false },
      { label: 'Week', val: (x) => x.stype * 100 + x.week, cell: (x) => weekLabel(x.stype, x.week), num: false },
      { label: 'Points', val: (x) => x.points, num: true }, { label: 'Right', val: (x) => x.correct, cell: (x) => `${x.correct}/${x.games}`, num: true },
      { label: 'Exact', val: (x) => x.exact, num: true }, { label: 'Margin err', val: (x) => x.avgMarginErr, cell: (x) => num(x.avgMarginErr), num: true },
    ], r.results, { onRow: (x) => { location.hash = `#/u/${encodeURIComponent(x.user)}/${x.season}/${x.stype}/${x.week}`; } })];
  }
  show(h('h1', {}, 'Search'), tabs, h('div', { class: 'row' }, controls), results);
}

async function viewTeams(params) {
  if (!state.seasons.length) state.seasons = (await api('/seasons')).seasons;
  const season = params.season || '';
  const { teams } = await api(`/stats/teams${qs({ season })}`);
  show(
    h('h1', {}, 'Teams: who does everyone get wrong?'),
    h('p', { class: 'muted' }, 'Every pick from every player. "Overrated" = picked to win more often than they actually won; click a column to re-sort.'),
    h('div', { class: 'row' }, select([['', 'All seasons'], ...state.seasons.map((s) => [s.season, s.season])], season, (v) => { location.hash = `#/teams${qs({ season: v })}`; }, 'Season')),
    teamTable(teams, 7));
}

// ---------- router ----------
async function route() {
  const [path, query] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  renderChrome();
  try {
    const [page, a, b, c, d] = parts;
    if (!page || page === 'picks') await viewPicks(params);
    else if (page === 'login') viewLogin();
    else if (page === 'u' && a && d) await viewUserWeek(a, b, c, d);
    else if (page === 'u' && a) await viewProfile(a, { season: b });
    else if (page === 'leaderboard') await viewLeaderboard(params);
    else if (page === 'search') await viewSearch(params);
    else if (page === 'teams') await viewTeams(params);
    else show(h('p', {}, 'Page not found.'));
  } catch (e) {
    show(h('p', { class: 'card bad' }, e.message));
  }
  window.scrollTo(0, 0);
}

(async () => {
  try {
    const me = await api('/me');
    state.me = me.user;
    state.scoring = me.scoring;
  } catch { /* offline: render logged-out */ }
  window.addEventListener('hashchange', route);
  route();
})();
