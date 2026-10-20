'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../lib/db');
const { createApp } = require('../lib/app');
const { upsertGames } = require('../lib/espn');
const { scorePick } = require('../lib/scoring');

const game = (id, week, kickoff, hs, as, extra = {}) => ({
  id, season: 2024, stype: 2, week, kickoff, home: 'KC', away: 'BAL', home_name: 'Kansas City Chiefs', away_name: 'Baltimore Ravens',
  home_logo: null, away_logo: null, home_score: hs, away_score: as, status: hs == null ? 'scheduled' : 'final', ...extra,
});

async function setup() {
  const db = openDb(':memory:');
  const past = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const future = new Date(Date.now() + 864e5).toISOString();
  upsertGames(db, [
    game('g1', 1, past(30), 27, 20),
    game('g2', 1, past(30), 10, 31, { home: 'NE', home_name: 'New England Patriots' }),
    game('g3', 2, future, null, null),
    game('g4', 3, new Date(Date.now() + 8 * 864e5).toISOString(), null, null),
  ]);
  const server = createApp(db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  return { db, server, client };
}

test('scoring: winner, margin bonus and exact score', () => {
  const g = { status: 'final', home_score: 27, away_score: 20 };
  assert.equal(scorePick({ home_pick: 27, away_pick: 20 }, g).points, 20);
  assert.equal(scorePick({ home_pick: 24, away_pick: 20 }, g).points, 10 + 5 - 3);
  assert.equal(scorePick({ home_pick: 10, away_pick: 30 }, g).points, 0);
  assert.equal(scorePick({ home_pick: 1, away_pick: 0 }, { status: 'scheduled' }), null);
});

test('register, pick, lock rules, history and visibility', async () => {
  const { server, client } = await setup();
  try {
    const ann = client(), bob = client(), anon = client();
    assert.equal((await ann('POST', '/api/register', { username: 'ann', password: 'password1' })).status, 200);
    assert.equal((await ann('POST', '/api/register', { username: 'ann', password: 'password1' })).status, 409);
    assert.equal((await bob('POST', '/api/register', { username: 'bob', password: 'short' })).status, 400);
    await bob('POST', '/api/register', { username: 'bob', password: 'password1' });

    // picks on finished games are locked; future game accepts picks
    let r = await ann('PUT', '/api/picks', { picks: [{ gameId: 'g1', home: 24, away: 20 }, { gameId: 'g3', home: 21, away: 17 }] });
    assert.deepEqual(r.data.saved, ['g3']);
    assert.equal(r.data.rejected[0].reason, 'locked');
    assert.equal((await anon('PUT', '/api/picks', { picks: [{ gameId: 'g3', home: 1, away: 2 }] })).status, 401);
    assert.equal((await ann('PUT', '/api/picks', { picks: [{ gameId: 'g3', home: -1, away: 2 }] })).status, 400);

    // other users cannot see an unlocked pick
    r = await bob('GET', '/api/users/ann/picks?season=2024&stype=2&week=2');
    assert.equal(r.data.games.length, 0);
    r = await ann('GET', '/api/users/ann/picks?season=2024&stype=2&week=2');
    assert.equal(r.data.games.length, 1);
  } finally { server.close(); }
});

test('stats, leaderboard and searches over finished games', async () => {
  const { db, server, client } = await setup();
  try {
    const ann = client(), bob = client();
    await ann('POST', '/api/register', { username: 'ann', password: 'password1' });
    await bob('POST', '/api/register', { username: 'bob', password: 'password1' });
    const id = (n) => db.prepare('SELECT id FROM users WHERE username=?').get(n).id;
    const ins = db.prepare('INSERT INTO picks (user_id, game_id, home_pick, away_pick) VALUES (?,?,?,?)');
    ins.run(id('ann'), 'g1', 27, 20); // exact: 20
    ins.run(id('ann'), 'g2', 10, 31); // exact: 20
    ins.run(id('bob'), 'g1', 20, 27); // wrong
    ins.run(id('bob'), 'g2', 13, 30); // right winner, margin off by 4 => 10 + 1

    const lb = (await ann('GET', '/api/leaderboard')).data.leaderboard;
    assert.deepEqual(lb.map((e) => [e.user, e.points]), [['ann', 40], ['bob', 11]]);

    const st = (await ann('GET', '/api/users/ann/stats')).data;
    assert.equal(st.overall.games, 2);
    assert.equal(st.overall.pct, 100);
    assert.equal(st.overall.exact, 2);
    assert.equal(st.byWeek.length, 1);
    assert.equal(st.byTeam.find((t) => t.team === 'KC').games, 1);

    const worst = (await ann('GET', '/api/search/weeks?order=worst&minGames=1')).data.results;
    assert.equal(worst[0].user, 'bob');
    const miss = (await ann('GET', '/api/search/picks?sort=biggestMiss&user=bob')).data;
    assert.equal(miss.results[0].result.marginErr, 14);
    assert.equal((await ann('GET', '/api/search/picks?result=nope')).status, 400);
    assert.equal((await ann('GET', '/api/search/seasons?minGames=1')).data.results.length, 2);
  } finally { server.close(); }
});

test('weeks unlock one at a time', async () => {
  const { server, client } = await setup();
  try {
    const ann = client();
    await ann('POST', '/api/register', { username: 'ann', password: 'password1' });
    // week 3 is not open while week 2 is still to be played
    let r = await ann('PUT', '/api/picks', { picks: [{ gameId: 'g4', home: 20, away: 10 }] });
    assert.deepEqual(r.data.saved, []);
    assert.equal(r.data.rejected[0].reason, 'not_open_yet');
    r = await ann('GET', '/api/games?season=2024&stype=2&week=3');
    assert.equal(r.data.open, false);
    assert.equal(r.data.opensAfter.week, 2);
    assert.equal(r.data.games[0].pickable, false);
    // week 2 is open (week 1 is over)
    r = await ann('GET', '/api/games?season=2024&stype=2&week=2');
    assert.equal(r.data.open, true);
    assert.equal(r.data.games[0].pickable, true);
    r = await ann('GET', '/api/periods?season=2024');
    assert.deepEqual(r.data.periods.map((p) => p.open), [true, true, false]);
    assert.equal(r.data.current.week, 2);
  } finally { server.close(); }
});
