// Runs the real migration in an in-process Postgres (PGlite) with a stand-in for Supabase's auth
// plumbing, then exercises the rules the app depends on: who can read/write what, how weeks unlock,
// and the scoring and stats views.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { scorePick } from '../site/scoring.js';

const MIGRATION = new URL('../supabase/migrations/20261020000000_picks.sql', import.meta.url);

const ANN = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';
const EVE = '00000000-0000-0000-0000-00000000000e'; // signed in but has no access to the project

let db;

// stand-ins for what Supabase provides
const BOOTSTRAP = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to authenticated, service_role, anon;
  create table public.project_access (user_id uuid, project_slug text, primary key (user_id, project_slug));
  create table public.profiles (user_id uuid primary key, handle text, display_name text not null default '');
  grant select on public.project_access, public.profiles to authenticated, service_role;
`;

// run a statement as a signed-in user (RLS applies), then go back to the superuser
async function as(user, sql, params) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false)`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const rejects = (p) => assert.rejects(p, /row-level security|violates|permission denied/i);

const game = (id, season, stype, week, kickoff, hs, as_) => ({
  id, season, stype, week, kickoff, hs, as_,
  status: hs == null ? 'scheduled' : 'final',
});
const ago = (days) => `now() - interval '${days} days'`;
const ahead = (days) => `now() + interval '${days} days'`;

async function addGames(list) {
  for (const g of list) {
    await db.query(
      `insert into picks.games (id, season, stype, week, kickoff, home, away, home_name, away_name, home_score, away_score, status)
       values ($1, $2, $3, $4, ${g.kickoff}, $5, $6, $5, $6, $7, $8, $9)`,
      [g.id, g.season, g.stype, g.week, g.home ?? 'KC', g.away ?? 'BAL', g.hs, g.as_, g.status],
    );
  }
}

before(async () => {
  db = new PGlite();
  await db.exec(BOOTSTRAP);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(`
    insert into auth.users values ('${ANN}'), ('${BOB}'), ('${EVE}');
    insert into public.project_access values ('${ANN}', 'picks'), ('${BOB}', 'picks');
    insert into public.profiles values ('${ANN}', 'ann', 'Ann A'), ('${BOB}', 'bob', '');
  `);
  await addGames([
    // 2025 week 1: two finished games a month ago
    { ...game('a1', 2025, 2, 1, ago(30), 27, 20), home: 'KC', away: 'BAL' },
    { ...game('a2', 2025, 2, 1, ago(30), 10, 31), home: 'NE', away: 'KC' },
    // 2025 week 2: still to be played, so open (week 1 is over)
    game('b1', 2025, 2, 2, ahead(1), null, null),
    // 2025 week 3: not open until week 2 ends
    game('c1', 2025, 2, 3, ahead(8), null, null),
    // a game in week 2 that already kicked off (locked) but isn't final
    game('b0', 2025, 2, 2, ago(0), null, null),
  ]);
  // can't have a past kickoff un-final via the helper above; b0 kicked off a moment ago
  await db.exec(`update picks.games set kickoff = now() - interval '1 hour' where id = 'b0'`);
});

test('scoring: SQL view agrees with the JS implementation', async () => {
  const cases = [
    [27, 20], [24, 20], [10, 30], [20, 27], [21, 21], [0, 0], [30, 24], [28, 20],
  ];
  const g = { status: 'final', home_score: 27, away_score: 20 };
  await db.query(`delete from picks.picks`);
  await db.query(`update picks.games set home_score = 27, away_score = 20 where id = 'a1'`);
  for (const [i, [h, a]] of cases.entries()) {
    const id = `00000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`;
    await db.query(`insert into auth.users values ($1)`, [id]);
    await db.query(`insert into picks.picks (user_id, game_id, home_pick, away_pick) values ($1, 'a1', $2, $3)`, [id, h, a]);
    const { rows } = await db.query(`select points, correct, exact, margin_err, total_err from picks.scored where user_id = $1`, [id]);
    const js = scorePick({ home_pick: h, away_pick: a }, g);
    assert.deepEqual(
      [rows[0].points, rows[0].correct, rows[0].exact, rows[0].margin_err, rows[0].total_err],
      [js.points, js.correct, js.exact, js.marginErr, js.totalErr],
      `pick ${h}-${a}`,
    );
  }
  await db.query(`delete from picks.picks`);
});

test('weeks unlock one at a time', async () => {
  const { rows } = await as(ANN, `select week, ended, open from picks.periods order by week`);
  assert.deepEqual(rows.map((r) => [r.week, r.ended, r.open]), [[1, true, true], [2, false, true], [3, false, false]]);
});

test('picks are only accepted while a game is open', async () => {
  const ins = (id) => as(ANN, `insert into picks.picks (game_id, home_pick, away_pick) values ($1, 24, 17)`, [id]);
  await ins('b1'); // open week, game in the future
  await rejects(ins('c1')); // week 3 has not unlocked
  await rejects(ins('b0')); // already kicked off
  await rejects(ins('a1')); // already final
  await rejects(as(ANN, `insert into picks.picks (game_id, home_pick, away_pick) values ('b1', 100, 3)`)); // out of range
  await rejects(as(EVE, `insert into picks.picks (game_id, home_pick, away_pick) values ('b1', 1, 2)`)); // no access
  // can edit while open
  await as(ANN, `update picks.picks set home_pick = 30 where game_id = 'b1'`);
  assert.equal((await as(ANN, `select home_pick from picks.picks where game_id = 'b1'`)).rows[0].home_pick, 30);
  // can't write as someone else
  await rejects(as(BOB, `insert into picks.picks (user_id, game_id, home_pick, away_pick) values ('${ANN}', 'b1', 1, 1)`));
});

test('other players only see picks once the game has kicked off', async () => {
  // Ann also picked the game that has kicked off, directly (as the service would have when it was open)
  await db.query(`insert into picks.picks (user_id, game_id, home_pick, away_pick) values ($1, 'b0', 3, 0)`, [ANN]);
  const bobSees = (await as(BOB, `select game_id from picks.picks where user_id = '${ANN}' order by game_id`)).rows.map((r) => r.game_id);
  assert.deepEqual(bobSees, ['b0']); // b1 is still open: hidden
  const annSees = (await as(ANN, `select game_id from picks.picks order by game_id`)).rows.map((r) => r.game_id);
  assert.deepEqual(annSees, ['b0', 'b1']);
  // no access to the project: nothing at all
  assert.equal((await as(EVE, `select * from picks.picks`)).rows.length, 0);
  assert.equal((await as(EVE, `select * from picks.games`)).rows.length, 0);
  await rejects(as(BOB, `delete from picks.picks where game_id = 'b1'`).then((r) => { if (!r.affectedRows) throw new Error('row-level security: nothing deleted'); }));
});

test('games are read-only for players', async () => {
  await rejects(as(ANN, `update picks.games set home_score = 99 where id = 'a1'`).then((r) => { if (!r.affectedRows) throw new Error('permission denied'); }));
  await rejects(as(ANN, `insert into picks.games (id, season, stype, week, kickoff, home, away, home_name, away_name) values ('x', 1, 2, 1, now(), 'A', 'B', 'A', 'B')`));
});

test('week, season, team and streak stats', async () => {
  await db.query(`delete from picks.picks`);
  await db.query(`update picks.games set home_score = 27, away_score = 20, status = 'final' where id = 'a1'`);
  const ins = (u, g, h, a) => db.query(`insert into picks.picks (user_id, game_id, home_pick, away_pick) values ($1, $2, $3, $4)`, [u, g, h, a]);
  await ins(ANN, 'a1', 27, 20); // exact: 20
  await ins(ANN, 'a2', 10, 31); // exact: 20
  await ins(BOB, 'a1', 20, 27); // wrong: 0
  await ins(BOB, 'a2', 13, 30); // right, margin off by 4: 11

  const week = (await as(ANN, `select name, handle, games, correct, exact, points, pct, avg_margin_err, games_in_week from picks.week_scores order by points desc`)).rows;
  assert.equal(week[0].name, 'Ann A');
  assert.equal(week[0].points, 40);
  assert.equal(week[0].exact, 2);
  assert.equal(week[0].games_in_week, 2);
  assert.equal(week[1].name, '@bob');
  assert.equal(week[1].points, 11);
  assert.equal(Number(week[1].pct), 50);
  assert.equal(Number(week[1].avg_margin_err), 9);

  const season = (await as(ANN, `select points, games from picks.season_scores where handle = 'bob'`)).rows[0];
  assert.deepEqual([season.points, season.games], [11, 2]);

  const kc = (await as(ANN, `select games, picked_win, actual_win, pred_for, actual_for from picks.team_stats where handle = 'ann' and team = 'KC'`)).rows[0];
  // KC at home in a1 (27-20, picked 27-20) and away in a2 (31 vs NE 10, picked 31-10)
  assert.deepEqual([kc.games, kc.picked_win, kc.actual_win, kc.pred_for, kc.actual_for], [2, 2, 2, 58, 58]);

  const streak = (await as(ANN, `select longest, current from picks.streaks where user_id = '${ANN}'`)).rows[0];
  assert.deepEqual([streak.longest, streak.current], [2, 2]);
  const bobStreak = (await as(ANN, `select longest, current from picks.streaks where user_id = '${BOB}'`)).rows[0];
  assert.deepEqual([bobStreak.longest, bobStreak.current], [1, 1]); // wrong then right

  const teams = (await as(ANN, `select abbr from picks.teams order by abbr`)).rows.map((r) => r.abbr);
  assert.deepEqual(teams, ['BAL', 'KC', 'NE']);
});

test('a stalled week does not block later weeks forever', async () => {
  await db.query(`update picks.games set kickoff = now() - interval '4 days' where id in ('b0')`);
  await db.query(`insert into picks.games (id, season, stype, week, kickoff, home, away, home_name, away_name)
                  values ('stuck', 2026, 2, 1, now() - interval '10 days', 'A', 'B', 'A', 'B')`);
  // 2026 week 1 never finished but kicked off 10 days ago: counts as ended
  await db.query(`insert into picks.games (id, season, stype, week, kickoff, home, away, home_name, away_name)
                  values ('next', 2026, 2, 2, now() + interval '2 days', 'A', 'B', 'A', 'B')`);
  const { rows } = await as(ANN, `select picks.game_pickable('next') as ok`);
  // 2025 week 2/3 still have games ahead or unfinished, so 2026 week 2 is not open yet
  assert.equal(rows[0].ok, false);
  await db.query(`update picks.games set kickoff = now() - interval '9 days' where season = 2025 and week in (2, 3)`);
  assert.equal((await as(ANN, `select picks.game_pickable('next') as ok`)).rows[0].ok, true);
});
