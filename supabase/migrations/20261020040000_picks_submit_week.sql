-- A week's picks are submitted as a whole. A player can no longer insert or edit pick rows directly; they
-- call picks.submit_week(), which refuses the submission unless every game that is still open in that week
-- has a pick. The rules are enforced here, not in the browser.
--
--   * the week must be open, and the caller must have access to the picks project,
--   * every game in the week that has not kicked off must be included (games that already kicked off cannot
--     be picked any more, so they do not block a submission and are ignored if sent),
--   * scores are whole numbers from 0 to 99,
--   * resubmitting before kickoff replaces the earlier picks for the games that are still open.

drop policy "make own picks while the game is open" on picks.picks;
drop policy "change own picks while the game is open" on picks.picks;
drop policy "clear own picks while the game is open" on picks.picks;
revoke insert, update, delete on picks.picks from authenticated;

create function picks.submit_week(p_season int, p_stype int, p_week int, p_picks jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_open text[];
  v_missing text[];
  v_saved int;
begin
  if v_user is null or not picks.has_access() then
    raise exception 'You do not have access to picks' using errcode = '42501';
  end if;
  if jsonb_typeof(p_picks) is distinct from 'array' then
    raise exception 'Send the picks as a list';
  end if;
  if not picks.period_open(p_season, p_stype, p_week) then
    raise exception 'This week is not open for picks yet';
  end if;

  select coalesce(array_agg(g.id order by g.kickoff, g.id), '{}') into v_open
  from picks.games g
  where g.season = p_season and g.stype = p_stype and g.week = p_week
    and g.status <> 'final' and g.kickoff > now();
  if cardinality(v_open) = 0 then
    raise exception 'No games are open for picks in this week';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_picks) as s(game_id text, home_pick int, away_pick int)
    where s.game_id is null or s.home_pick is null or s.away_pick is null
       or s.home_pick not between 0 and 99 or s.away_pick not between 0 and 99
  ) then
    raise exception 'Scores must be whole numbers from 0 to 99';
  end if;

  select coalesce(array_agg(o order by o), '{}') into v_missing
  from unnest(v_open) o
  where not exists (
    select 1 from jsonb_to_recordset(p_picks) as s(game_id text, home_pick int, away_pick int) where s.game_id = o
  );
  if cardinality(v_missing) > 0 then
    raise exception 'Pick every game before submitting (% still missing)', cardinality(v_missing) using errcode = 'P0001';
  end if;

  insert into picks.picks (user_id, game_id, home_pick, away_pick)
  select v_user, s.game_id, s.home_pick, s.away_pick
  from jsonb_to_recordset(p_picks) as s(game_id text, home_pick int, away_pick int)
  where s.game_id = any (v_open)
  on conflict (user_id, game_id) do update
    set home_pick = excluded.home_pick, away_pick = excluded.away_pick;
  get diagnostics v_saved = row_count;
  return v_saved;
end $$;

revoke all on function picks.submit_week(int, int, int, jsonb) from public, anon;
grant execute on function picks.submit_week(int, int, int, jsonb) to authenticated, service_role;
