-- Live game details, and a way to open a week early.

-- 1. Live games. While a game is in progress its row carries the running score and the situation
--    (clock text, who has the ball, down and distance, field position). These columns are cleared
--    again by the sync function once the game is no longer live.
alter table picks.games
  add column detail        text,                         -- e.g. "5:21 - 3rd", "Halftime"
  add column possession    text,                         -- abbreviation of the team with the ball
  add column down_distance text,                         -- e.g. "2nd & 8"
  add column field_pos     text,                         -- e.g. "KC 35"
  add column red_zone      boolean not null default false;

alter table picks.games drop constraint games_status_check;
alter table picks.games drop constraint games_check;
alter table picks.games add constraint games_status_check check (status in ('scheduled', 'live', 'final'));
-- a finished game always has both scores; a live one has the running score
alter table picks.games add constraint games_final_has_scores
  check (status <> 'final' or (home_score is not null and away_score is not null));

-- 2. Weeks normally unlock one at a time. open_weeks lists weeks opened ahead of that order (managed
--    from the SQL editor / service role; players can only read it). Delete a row to go back to the rule.
create table picks.open_weeks (
  season int not null,
  stype  int not null,
  week   int not null,
  primary key (season, stype, week)
);
alter table picks.open_weeks enable row level security;
revoke all on picks.open_weeks from anon, authenticated;
grant select on picks.open_weeks to authenticated;
grant all on picks.open_weeks to service_role;
create policy "picks users read opened weeks"
  on picks.open_weeks for select to authenticated
  using (picks.has_access());

create or replace function picks.period_open(p_season int, p_stype int, p_week int) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from picks.open_weeks o where (o.season, o.stype, o.week) = (p_season, p_stype, p_week))
    or not exists (
      select 1 from picks.games g
      where (g.season, g.stype, g.week) < (p_season, p_stype, p_week)
      group by g.season, g.stype, g.week
      having bool_or(g.status <> 'final') and max(g.kickoff) + interval '3 days' > now()
    )
$$;

create or replace view picks.periods with (security_invoker = true) as
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
         ), true)
         or exists (select 1 from picks.open_weeks o where (o.season, o.stype, o.week) = (q.season, q.stype, q.week))
         as open
  from q;
