-- NFL score picks. Everything lives in its own `picks` schema, separate from the dashboard's `public`.
-- The schema must also be listed under Settings > API > Exposed schemas so the client can reach it.
-- Only users with access to the 'picks' project (public.project_access) can read or write anything here.
--
-- Rules enforced in the database (the browser is never trusted):
--   * a game accepts picks only until its kickoff,
--   * a week opens only after every earlier week (across seasons, playoffs included) has ended,
--   * other people see a pick only once its game has kicked off, so nobody can copy picks,
--   * games and results are written only by the sync Edge Function (service role).
--
-- Scoring (max 20 per game): 10 for the right winner (or a correctly called tie),
-- plus 5 minus how far the predicted margin was off (floor 0), plus 5 for the exact score.

create schema if not exists picks;
grant usage on schema picks to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------

create function picks.has_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_access a
    where a.user_id = (select auth.uid()) and a.project_slug = 'picks'
  )
$$;
revoke all on function picks.has_access() from public, anon;
grant execute on function picks.has_access() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- games (schedule and results, filled in by the sync-games Edge Function)
-- ---------------------------------------------------------------------------------------------

create table picks.games (
  id         text primary key,                                   -- ESPN event id
  season     int  not null,
  stype      int  not null check (stype in (2, 3)),              -- 2 = regular season, 3 = postseason
  week       int  not null,                                      -- ESPN numbering (postseason: 1 WC, 2 DIV, 3 CONF, 5 Super Bowl)
  kickoff    timestamptz not null,
  home       text not null,
  away       text not null,
  home_name  text not null,
  away_name  text not null,
  home_logo  text,
  away_logo  text,
  home_score int check (home_score >= 0),
  away_score int check (away_score >= 0),
  status     text not null default 'scheduled' check (status in ('scheduled', 'final')),
  updated_at timestamptz not null default now(),
  check ((status = 'final') = (home_score is not null and away_score is not null))
);
create index games_period_idx on picks.games (season, stype, week);
create index games_kickoff_idx on picks.games (kickoff);

-- bookkeeping for the sync function (one row)
create table picks.sync_state (
  id             int primary key default 1 check (id = 1),
  last_sync      timestamptz,
  last_full_sync timestamptz
);
insert into picks.sync_state (id) values (1);

alter table picks.games enable row level security;
alter table picks.sync_state enable row level security;
revoke all on picks.games, picks.sync_state from anon, authenticated;
grant select on picks.games to authenticated;
grant all on picks.games, picks.sync_state to service_role;

create policy "picks users read games"
  on picks.games for select to authenticated
  using (picks.has_access());

-- ---------------------------------------------------------------------------------------------
-- weeks: which are over, which are open for picks
-- ---------------------------------------------------------------------------------------------

-- A week has ended when all its games are final, or 3 days after its last kickoff
-- (so a postponed or cancelled game can never block the schedule). A week is open once every
-- earlier week has ended.
create view picks.periods with (security_invoker = true) as
  with p as (
    select season, stype, week,
           count(*) as games,
           count(*) filter (where status = 'final') as final_games,
           min(kickoff) as first_kickoff,
           max(kickoff) as last_kickoff
    from picks.games
    group by season, stype, week
  ), q as (
    select *, (final_games = games or last_kickoff + interval '3 days' < now()) as ended from p
  )
  select season, stype, week, games, final_games, first_kickoff, last_kickoff, ended,
         coalesce(bool_and(ended) over (
           order by season, stype, week rows between unbounded preceding and 1 preceding
         ), true) as open
  from q;

create function picks.period_open(p_season int, p_stype int, p_week int) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from picks.games g
    where (g.season, g.stype, g.week) < (p_season, p_stype, p_week)
    group by g.season, g.stype, g.week
    having bool_or(g.status <> 'final') and max(g.kickoff) + interval '3 days' > now()
  )
$$;

create function picks.game_locked(p_game_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select g.status = 'final' or g.kickoff <= now() from picks.games g where g.id = p_game_id), false)
$$;

create function picks.game_pickable(p_game_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select g.status <> 'final' and g.kickoff > now() and picks.period_open(g.season, g.stype, g.week)
    from picks.games g where g.id = p_game_id
  ), false)
$$;

revoke all on function picks.period_open(int, int, int), picks.game_locked(text), picks.game_pickable(text) from public, anon;
grant execute on function picks.period_open(int, int, int), picks.game_locked(text), picks.game_pickable(text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- picks
-- ---------------------------------------------------------------------------------------------

create table picks.picks (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  game_id    text not null references picks.games (id) on delete cascade,
  home_pick  int  not null check (home_pick between 0 and 99),
  away_pick  int  not null check (away_pick between 0 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index picks_game_idx on picks.picks (game_id);

create function picks.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger picks_touch
  before update on picks.picks
  for each row execute function picks.touch();

alter table picks.picks enable row level security;
revoke all on picks.picks from anon, authenticated;
grant select, insert, update, delete on picks.picks to authenticated;
grant all on picks.picks to service_role;

create policy "read own picks"
  on picks.picks for select to authenticated
  using (user_id = (select auth.uid()) and picks.has_access());

create policy "read picks once the game has kicked off"
  on picks.picks for select to authenticated
  using (picks.has_access() and picks.game_locked(game_id));

create policy "make own picks while the game is open"
  on picks.picks for insert to authenticated
  with check (user_id = (select auth.uid()) and picks.has_access() and picks.game_pickable(game_id));

create policy "change own picks while the game is open"
  on picks.picks for update to authenticated
  using (user_id = (select auth.uid()) and picks.has_access() and picks.game_pickable(game_id))
  with check (user_id = (select auth.uid()) and picks.has_access() and picks.game_pickable(game_id));

create policy "clear own picks while the game is open"
  on picks.picks for delete to authenticated
  using (user_id = (select auth.uid()) and picks.has_access() and picks.game_pickable(game_id));

-- ---------------------------------------------------------------------------------------------
-- scoring and stats (views run with the caller's rights, so the policies above still apply:
-- you only ever aggregate picks you are allowed to see, which for finished games is everyone's)
-- ---------------------------------------------------------------------------------------------

-- every pick on a finished game, scored
create view picks.scored with (security_invoker = true) as
  with s as (
    select p.user_id,
           coalesce(nullif(pr.display_name, ''), '@' || pr.handle, 'Player ' || left(p.user_id::text, 4)) as name,
           pr.handle,
           g.id as game_id, g.season, g.stype, g.week, g.kickoff,
           g.home, g.away, g.home_name, g.away_name, g.home_logo, g.away_logo,
           g.home_score, g.away_score, p.home_pick, p.away_pick,
           sign((p.home_pick - p.away_pick)::numeric) = sign((g.home_score - g.away_score)::numeric) as correct,
           (p.home_pick = g.home_score and p.away_pick = g.away_score) as exact,
           abs((p.home_pick - p.away_pick) - (g.home_score - g.away_score)) as margin_err,
           abs(p.home_pick - g.home_score) + abs(p.away_pick - g.away_score) as total_err,
           abs(g.home_score - g.away_score) as blowout
    from picks.picks p
    join picks.games g on g.id = p.game_id
    left join public.profiles pr on pr.user_id = p.user_id
    where g.status = 'final'
  )
  select s.*,
         (case when s.correct then 10 + greatest(0, 5 - s.margin_err) else 0 end)
           + (case when s.exact then 5 else 0 end) as points
  from s;

-- One row per player per week. The *_sum columns are additive, so the client can combine rows
-- (for a season or all time) without losing exactness.
create view picks.week_scores with (security_invoker = true) as
  select s.user_id, max(s.name) as name, max(s.handle) as handle, s.season, s.stype, s.week,
         count(*)::int as games,
         (count(*) filter (where s.correct))::int as correct,
         (count(*) filter (where s.exact))::int as exact,
         sum(s.points)::int as points,
         sum(s.margin_err)::int as margin_err_sum,
         sum(s.total_err)::int as total_err_sum,
         round(100.0 * count(*) filter (where s.correct) / count(*), 1) as pct,
         round(sum(s.points)::numeric / count(*), 2) as avg_points,
         round(sum(s.margin_err)::numeric / count(*), 2) as avg_margin_err,
         round(sum(s.total_err)::numeric / count(*), 2) as avg_total_err,
         coalesce(max(p.final_games), count(*))::int as games_in_week
  from picks.scored s
  left join picks.periods p on (p.season, p.stype, p.week) = (s.season, s.stype, s.week)
  group by s.user_id, s.season, s.stype, s.week;

create view picks.season_scores with (security_invoker = true) as
  select s.user_id, max(s.name) as name, max(s.handle) as handle, s.season,
         count(*)::int as games,
         (count(*) filter (where s.correct))::int as correct,
         (count(*) filter (where s.exact))::int as exact,
         sum(s.points)::int as points,
         sum(s.margin_err)::int as margin_err_sum,
         sum(s.total_err)::int as total_err_sum,
         round(100.0 * count(*) filter (where s.correct) / count(*), 1) as pct,
         round(sum(s.points)::numeric / count(*), 2) as avg_points,
         round(sum(s.margin_err)::numeric / count(*), 2) as avg_margin_err,
         round(sum(s.total_err)::numeric / count(*), 2) as avg_total_err
  from picks.scored s
  group by s.user_id, s.season;

-- Per player, per season, per team (every finished game involving the team). Additive columns.
create view picks.team_stats with (security_invoker = true) as
  select t.user_id, max(t.name) as name, max(t.handle) as handle, t.season,
         t.team, max(t.team_name) as team_name, max(t.team_logo) as team_logo,
         count(*)::int as games,
         (count(*) filter (where t.correct))::int as correct,
         (count(*) filter (where t.exact))::int as exact,
         sum(t.points)::int as points,
         sum(t.margin_err)::int as margin_err_sum,
         sum(t.total_err)::int as total_err_sum,
         (count(*) filter (where t.pf > t.pa))::int as picked_win,
         (count(*) filter (where t.af > t.aa))::int as actual_win,
         sum(t.pf)::int as pred_for,
         sum(t.af)::int as actual_for
  from (
    select s.user_id, s.name, s.handle, s.season, s.correct, s.exact, s.points, s.margin_err, s.total_err,
           s.home as team, s.home_name as team_name, s.home_logo as team_logo,
           s.home_pick as pf, s.away_pick as pa, s.home_score as af, s.away_score as aa
    from picks.scored s
    union all
    select s.user_id, s.name, s.handle, s.season, s.correct, s.exact, s.points, s.margin_err, s.total_err,
           s.away, s.away_name, s.away_logo,
           s.away_pick, s.home_pick, s.away_score, s.home_score
    from picks.scored s
  ) t
  group by t.user_id, t.season, t.team;

-- longest and current run of right winners, per player
create view picks.streaks with (security_invoker = true) as
  with o as (
    select user_id, correct,
           row_number() over (partition by user_id order by kickoff, game_id) as rn,
           row_number() over (partition by user_id, correct order by kickoff, game_id) as rc
    from picks.scored
  ), islands as (
    select user_id, correct, count(*) as len, max(rn) as last_rn
    from o group by user_id, correct, rn - rc
  ), totals as (
    select user_id, max(rn) as total from o group by user_id
  )
  select i.user_id,
         coalesce(max(i.len) filter (where i.correct), 0)::int as longest,
         coalesce(max(i.len) filter (where i.correct and i.last_rn = t.total), 0)::int as current
  from islands i join totals t using (user_id)
  group by i.user_id;

-- every team, with its latest name and logo (for filters)
create view picks.teams with (security_invoker = true) as
  select distinct on (abbr) abbr, name, logo
  from (
    select home as abbr, home_name as name, home_logo as logo, kickoff from picks.games
    union all
    select away, away_name, away_logo, kickoff from picks.games
  ) x
  order by abbr, kickoff desc;

revoke all on picks.periods, picks.scored, picks.week_scores, picks.season_scores,
              picks.team_stats, picks.streaks, picks.teams from anon, authenticated;
grant select on picks.periods, picks.scored, picks.week_scores, picks.season_scores,
                picks.team_stats, picks.streaks, picks.teams to authenticated;
grant all on picks.periods, picks.scored, picks.week_scores, picks.season_scores,
             picks.team_stats, picks.streaks, picks.teams to service_role;
