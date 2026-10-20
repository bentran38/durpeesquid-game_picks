# NFL Picks

Pick the final score of every NFL game, keep your history forever, and compare yourself with everyone else.
Served at `picks.durpeesquid.com`. Static site (no framework), same Supabase project and shared login as
[durpeesquid](https://github.com/bentran38/durpeesquid): `site/session.js` imports
`https://www.durpeesquid.com/auth.js`, so the cookie session and the colour theme carry over.

- **Picks**: predict both scores for every game of the open week. Games lock at kickoff, and other players only see
  your pick after that, so nobody can copy.
- **Weeks unlock one at a time**: a week opens once every earlier week (across seasons, playoffs included) has ended.
  A week has ended when all its games are final, or 3 days after its last kickoff (so a postponed game can't block
  the schedule). New weeks, playoff rounds and next season's schedule arrive on their own (see "Keeping it current").
- **History** (`/me`, `/u/<handle>`, add `/<season>` or `/<season>/<stype>/<week>`): every season and week you have
  played, with picks next to the real results.
- **Leaderboard**: all time, a season or a single week, ranked by points, avg points, winner %, margin error or exact scores.
- **Search**: best/worst weeks and seasons (any player, any metric), and a pick explorer (biggest misses, closest calls,
  exact scores, blowouts, by team, player or season).
- **Stats**: per player and per team (accuracy, margin and total-score error, picked-to-win % vs actual win %,
  longest streak) and a community "most overrated team" table.

## Scoring (max 20 per game)

| | Points |
|---|---|
| Right winner (or a correctly called tie) | 10 |
| Margin bonus | 5 minus how far your predicted margin was off (min 0) |
| Exact score | +5 |

Scores are computed from picks and results when read, so changing the formula (`picks.scored` in the migration, plus
`site/scoring.js` for the per-game display) re-scores all history.

## How it fits together

- **Database**: its own `picks` schema (`supabase/migrations/20261020000000_picks.sql`): `games`, `picks`, and views
  (`periods`, `scored`, `week_scores`, `season_scores`, `team_stats`, `streaks`, `teams`). Row-level security does the
  enforcing, not the browser: picks are accepted only for games that haven't kicked off in an open week, other
  players' picks are invisible until kickoff, games and results are writable only by the sync function, and every
  policy requires `project_access` for slug `picks`. Views run with the caller's rights, so those rules apply to stats too.
- **Results**: the `sync-games` Edge Function reads ESPN's public scoreboard and upserts `picks.games`.
- **Site**: `site/` is plain ES modules. `app.js` (pages and routing), `api.js` (queries), `scoring.js`, `ui.js`.
  Same look as the other sites: tokens from `themes.css`, topbar, panels, chips.

## One-time setup

1. **Migration:** apply `supabase/migrations/20261020000000_picks.sql` to the shared Supabase project. Then add `picks`
   under Settings > API > Exposed schemas.
2. **Project row:** add a `picks` project in the admin dashboard (slug `picks`, title `NFL Picks`, url
   `https://picks.durpeesquid.com`) and give people access. Every policy requires `project_access` for slug `picks`.
3. **Sync function:**
   ```
   supabase secrets set SYNC_SECRET=<a long random string>
   supabase functions deploy sync-games --no-verify-jwt
   ```
   (JWT verification is off at the gateway; the function checks the secret itself.)
4. **Schedule it:** fill in and run `supabase/setup/schedule-sync.sql` in the SQL editor. It calls the function every
   2 minutes via pg_cron; the function decides whether there is work to do. Then load history once, e.g.:
   ```
   curl -X POST https://<project-ref>.supabase.co/functions/v1/sync-games \
     -H "x-sync-secret: <the string>" -H "content-type: application/json" \
     -d '{"seasons":[2023,2024,2025]}'
   ```
5. **Vercel:** import this repo, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as the main
   site). Add `picks.durpeesquid.com` as a domain and a CNAME in Cloudflare (DNS only), as in the main README.
6. **Icon (optional):** `picks` has an icon in the main site's `site/project-icons.js`; without it the card shows an initial.

## Keeping it current

`sync-games` runs on a 2-minute schedule and does only what is needed: while games are in progress it refreshes the
current week (1 ESPN request); otherwise every 30 minutes; and every 6 hours it refreshes every week of this season
**and the next one**. So a new season's schedule appears when ESPN publishes it, playoff rounds appear as their
matchups are set (undecided "TBD" matchups are skipped), and weeks unlock as the previous one ends. ESPN's API is
unofficial, so if its shape ever changes, `supabase/functions/sync-games/index.ts` is the only file to adjust.

## Local dev

- `npm run dev:mock` serves the site with a fake sign-in and an in-memory copy of the data (`dev/`), so every page can be
  tried without Supabase. Nothing in `dev/` is deployed.
- `npm run dev` serves the real site (needs `.env.local` with the two Supabase vars). Login lives on durpeesquid.com
  and the session cookie is not shared with `localhost`, so sign-in only works on a deployed preview or the real subdomain.
- `npm test` runs the real migration in an in-process Postgres (PGlite) and checks the access rules, week unlocking,
  scoring (SQL vs `site/scoring.js`) and the stats views. The test dependencies live in `test/` so Vercel never installs them.
