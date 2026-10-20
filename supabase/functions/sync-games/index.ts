// Keeps picks.games in step with ESPN's public NFL scoreboard: schedules (this season and next, so a
// new season appears on its own), playoff rounds as their matchups are set, and final scores.
// Called every couple of minutes by pg_cron (see supabase/setup/schedule-sync.sql) and decides for
// itself how much work is needed:
//   * games in progress           -> refresh the current week (1 ESPN request)
//   * otherwise, every 30 minutes -> refresh the current week
//   * every 6 hours               -> refresh every week of this season and the next
// verify_jwt is off at the gateway; the shared secret below is the check.
//
//   POST {}                         normal scheduled run
//   POST { "force": true }          full sync now
//   POST { "seasons": [2023, 2024] } full sync of those seasons (backfill history)
import { createClient } from 'npm:@supabase/supabase-js@2';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const LIVE_WINDOW_MS = 6 * 3600e3;
const PERIODS: [number, number][] = [
  ...Array.from({ length: 18 }, (_, i) => [2, i + 1] as [number, number]),
  [3, 1], [3, 2], [3, 3], [3, 5], // Wild Card, Divisional, Conference, Super Bowl (4 is the Pro Bowl)
];

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('picks');

async function espn(params: string): Promise<any> {
  const res = await fetch(`${SCOREBOARD}${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

// ESPN event -> picks.games row; null for anything that isn't a decided regular-season or playoff game
// (preseason, the Pro Bowl, playoff matchups that still show placeholder teams).
function toRow(e: any, fallback?: { season: number; stype: number; week: number }) {
  const season = e.season?.year ?? fallback?.season;
  const stype = e.season?.type ?? fallback?.stype;
  const week = e.week?.number ?? fallback?.week;
  if (!season || !week || (stype !== 2 && stype !== 3) || (stype === 3 && week === 4)) return null;
  const comp = e.competitions?.[0];
  const home = comp?.competitors?.find((c: any) => c.homeAway === 'home');
  const away = comp?.competitors?.find((c: any) => c.homeAway === 'away');
  const tbd = (c: any) => !c?.team?.abbreviation || /^(TBD|TBA)$/i.test(c.team.abbreviation);
  if (tbd(home) || tbd(away)) return null;
  const final = !!e.status?.type?.completed;
  const score = (c: any) => (final && c.score != null && c.score !== '' ? Number(c.score) : null);
  const hs = score(home), as = score(away);
  const isFinal = final && hs != null && as != null;
  return {
    id: String(e.id), season, stype, week,
    kickoff: new Date(e.date).toISOString(),
    home: home.team.abbreviation, away: away.team.abbreviation,
    home_name: home.team.displayName, away_name: away.team.displayName,
    home_logo: home.team.logo ?? null, away_logo: away.team.logo ?? null,
    home_score: isFinal ? hs : null, away_score: isFinal ? as : null,
    status: isFinal ? 'final' : 'scheduled',
    updated_at: new Date().toISOString(),
  };
}

async function upsert(rows: any[]) {
  if (!rows.length) return 0;
  const { error } = await db.from('games').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`upsert failed: ${error.message}`);
  return rows.length;
}

// the week ESPN currently shows
async function syncCurrent(): Promise<{ season: number; n: number }> {
  const json = await espn('');
  const rows = (json.events ?? []).map((e: any) => toRow(e, { season: json.season?.year, stype: json.season?.type, week: json.week?.number })).filter(Boolean);
  return { season: json.season?.year, n: await upsert(rows) };
}

async function syncSeason(season: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < PERIODS.length; i += 6) {
    const batch = PERIODS.slice(i, i + 6);
    const results = await Promise.all(batch.map(async ([stype, week]) => {
      try {
        const json = await espn(`?dates=${season}&seasontype=${stype}&week=${week}&limit=100`);
        return (json.events ?? []).map((e: any) => toRow(e, { season, stype, week })).filter(Boolean);
      } catch (err) {
        console.warn(`sync ${season} type ${stype} week ${week}: ${err}`);
        return [];
      }
    }));
    n += await upsert(results.flat());
  }
  return n;
}

async function liveGames(): Promise<boolean> {
  const now = new Date();
  const { data } = await db.from('games').select('id').neq('status', 'final')
    .lte('kickoff', now.toISOString()).gte('kickoff', new Date(now.getTime() - LIVE_WINDOW_MS).toISOString()).limit(1);
  return !!data?.length;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  const secret = Deno.env.get('SYNC_SECRET');
  if (!secret || req.headers.get('x-sync-secret') !== secret) return json({ error: 'forbidden' }, 403);

  let body: { force?: boolean; seasons?: number[] } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  try {
    const { data: state } = await db.from('sync_state').select('*').eq('id', 1).single();
    const age = (t?: string | null) => (t ? Date.now() - new Date(t).getTime() : Infinity);
    const now = new Date().toISOString();

    if (body.seasons?.length) {
      const done: Record<number, number> = {};
      for (const s of body.seasons.slice(0, 10)) done[s] = await syncSeason(Number(s));
      return json({ mode: 'backfill', done });
    }

    if (body.force || age(state?.last_full_sync) > 6 * 3600e3) {
      const { season } = await syncCurrent();
      const done: Record<number, number> = {};
      for (const s of [season, season + 1]) done[s] = await syncSeason(s);
      await db.from('sync_state').update({ last_sync: now, last_full_sync: now }).eq('id', 1);
      return json({ mode: 'full', done });
    }

    const live = await liveGames();
    if (live || age(state?.last_sync) > 30 * 60e3) {
      const r = await syncCurrent();
      await db.from('sync_state').update({ last_sync: now }).eq('id', 1);
      return json({ mode: live ? 'live' : 'current', ...r });
    }
    return json({ mode: 'idle' });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
