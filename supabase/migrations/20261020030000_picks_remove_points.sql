-- Removes the points system. There is no per-game score any more: players are compared on winners
-- right, exact scores and how far off their predicted scores were (margin error and total-score error).
-- Rankings use winners right, with ties broken by the smaller total-score error (see the site's leaderboard).
-- The views are rebuilt without the points / avg_points columns.

drop view picks.streaks;
drop view picks.team_stats;
drop view picks.season_scores;
drop view picks.week_scores;
drop view picks.scored;

create view picks.scored with (security_invoker = true) as
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
  where g.status = 'final';

create view picks.week_scores with (security_invoker = true) as
  select s.user_id, max(s.name) as name, max(s.handle) as handle, s.season, s.stype, s.week,
         count(*)::int as games,
         (count(*) filter (where s.correct))::int as correct,
         (count(*) filter (where s.exact))::int as exact,
         sum(s.margin_err)::int as margin_err_sum,
         sum(s.total_err)::int as total_err_sum,
         round(100.0 * count(*) filter (where s.correct) / count(*), 1) as pct,
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
         sum(s.margin_err)::int as margin_err_sum,
         sum(s.total_err)::int as total_err_sum,
         round(100.0 * count(*) filter (where s.correct) / count(*), 1) as pct,
         round(sum(s.margin_err)::numeric / count(*), 2) as avg_margin_err,
         round(sum(s.total_err)::numeric / count(*), 2) as avg_total_err
  from picks.scored s
  group by s.user_id, s.season;

create view picks.team_stats with (security_invoker = true) as
  select t.user_id, max(t.name) as name, max(t.handle) as handle, t.season,
         t.team, max(t.team_name) as team_name, max(t.team_logo) as team_logo,
         count(*)::int as games,
         (count(*) filter (where t.correct))::int as correct,
         (count(*) filter (where t.exact))::int as exact,
         sum(t.margin_err)::int as margin_err_sum,
         sum(t.total_err)::int as total_err_sum,
         (count(*) filter (where t.pf > t.pa))::int as picked_win,
         (count(*) filter (where t.af > t.aa))::int as actual_win,
         sum(t.pf)::int as pred_for,
         sum(t.af)::int as actual_for
  from (
    select s.user_id, s.name, s.handle, s.season, s.correct, s.exact, s.margin_err, s.total_err,
           s.home as team, s.home_name as team_name, s.home_logo as team_logo,
           s.home_pick as pf, s.away_pick as pa, s.home_score as af, s.away_score as aa
    from picks.scored s
    union all
    select s.user_id, s.name, s.handle, s.season, s.correct, s.exact, s.margin_err, s.total_err,
           s.away, s.away_name, s.away_logo,
           s.away_pick, s.home_pick, s.away_score, s.home_score
    from picks.scored s
  ) t
  group by t.user_id, t.season, t.team;

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

revoke all on picks.scored, picks.week_scores, picks.season_scores, picks.team_stats, picks.streaks from anon, authenticated;
grant select on picks.scored, picks.week_scores, picks.season_scores, picks.team_stats, picks.streaks to authenticated;
grant all on picks.scored, picks.week_scores, picks.season_scores, picks.team_stats, picks.streaks to service_role;
