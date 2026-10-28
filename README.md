# NFL Picks

Pick the final score of every NFL game, keep your history forever, and compare yourself with everyone else.
Served at `picks.durpeesquid.com`. Static site (no framework), same Supabase project and shared login as
[durpeesquid](https://github.com/bentran38/durpeesquid): `site/session.js` imports
`https://www.durpeesquid.com/auth.js`, so the cookie session and the colour theme carry over.

- **Picks**: predict both scores for every game of the open week. **A week is submitted whole**: the Submit button stays
  disabled until every game that has not kicked off has both scores (a progress bar shows how many are done), and the
  database refuses a partial submission, so it cannot be bypassed. You can resubmit changes until each game kicks off;
  a game that has already kicked off can no longer be picked and does not block submitting the rest. Games lock at
  kickoff, and other players only see your pick after that, so nobody can copy.
- **Weeks unlock one at a time**: a week opens once every earlier week (across seasons, playoffs included) has ended.
  A week has ended when all its games are final, or 3 days after its last kickoff (so a postponed game can't block
  the schedule). New weeks, playoff rounds and next season's schedule arrive on their own (see "Keeping it current").
- **Live games** show the running score, the clock, who has the ball, down and distance and field position when ESPN
  provides it, with your pick beside the score and whether it is ahead right now. The sync polls ESPN every 15 seconds
  while a game is on, and the page refreshes live cards every 20 seconds.
- **Opening a week early**: weeks normally unlock in order, but a row in `picks.open_weeks` opens a specific week ahead
  of that (`insert into picks.open_weeks values (2026, 2, 7);`, delete the row to go back to the rule).
- **History** (`/me`, `/u/<handle>`, add `/<season>` or `/<season>/<stype>/<week>`): every season and week you have
  played, with picks next to the real results.
- **Everyone's picks** (`/everyone`, add `?season=&stype=&week=`): every player's pick on every game of a week, past or
  current, next to the real result. Others' picks appear as each game kicks off.
- **Leaderboard**: all time, a season or a single week, ranked by winner % (default), margin error, total-score error or exact scores.
- **Search**: best/worst weeks and seasons (any player, any metric), and a pick explorer (biggest misses, closest calls,
  exact scores, blowouts, by team, player or season).
- **Seasons**: lists and searches start at 2026 (`FIRST_SEASON` in `site/api.js`); each later season appears on its own
  once its games exist.
- **Stats**: per player and per team (accuracy, margin and total-score error, picked-to-win % vs actual win %,
  longest streak) and a community "most overrated team" table.

## How picks are judged

There are no points. A pick on a finished game is judged on:

- **Winner %**: how often it had the right winner (or correctly called a tie), shown with the totals, e.g. `88.8% (326/367)`.
- **Exact**: it was the exact final score.
- **Margin error**: how far the predicted margin (home minus away) was from the real margin.
- **Total-score error**: how far the two predicted scores were from the real ones, added together.

Leaderboards and "best/worst" searches rank by the column you choose (winner % by default). Ties go to the smaller
total-score error. Everything is computed from picks and results when read
(`picks.scored` and the views built on it, plus `site/scoring.js` for the per-game display).

## How it fits together

- **Database**: its own `picks` schema (`supabase/migrations/20261020000000_picks.sql`): `games`, `picks`, and views
  (`periods`, `scored`, `week_scores`, `season_scores`, `team_stats`, `streaks`, `teams`). Row-level security does the
  enforcing, not the browser: picks can only be written through `picks.submit_week()` (no direct row writes), which
  accepts a week only if it is open and every unstarted game in it has a pick, other
  players' picks are invisible until kickoff, games and results are writable only by the sync function, and every
  policy requires `project_access` for slug `picks`. Views run with the caller's rights, so those rules apply to stats too.
- **Results**: the `sync-games` Edge Function reads ESPN's public scoreboard and upserts `picks.games`.
- **Site**: `site/` is plain ES modules. `app.js` (pages and routing), `api.js` (queries), `scoring.js`, `ui.js`.
  Same colour themes as the other sites (tokens from `themes.css`). One typeface (Inter, with system fallbacks), sentence-case
  labels, and motion that respects `prefers-reduced-motion`.

## Setup

Already done for the DurpeeSquid project (schema, exposed schema, function, schedule and 2023 onward loaded). To
rebuild elsewhere, or to see what exists:

1. **Migrations:** apply the files in `supabase/migrations/` in order (`..._picks.sql`, `..._picks_sync_auth.sql`, `..._picks_live_and_open_weeks.sql`, `..._picks_remove_points.sql`, `..._picks_submit_week.sql`).
   Then expose the schema to the API: add `picks` to Settings > API > Exposed schemas (or, in SQL,
   `alter role authenticator set pgrst.db_schemas = '<existing list>, picks'; notify pgrst, 'reload config';`).
2. **Project row:** a `picks` row in `public.projects` (slug `picks`, title `NFL Picks`, url
   `https://picks.durpeesquid.com`), then give people access on the admin dashboard. Every policy requires
   `project_access` for slug `picks`, so someone without it sees nothing.
3. **Sync function:** deploy `supabase/functions/sync-games` with JWT verification off
   (`supabase functions deploy sync-games --no-verify-jwt`). It authenticates callers with a secret in Vault, so
   there is no function secret to set.
4. **Schedule and history:** run `supabase/setup/schedule-sync.sql` (fills in the Vault secret, schedules the job and
   shows how to backfill seasons).
5. **Vercel:** import this repo, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as the main
   site). Add `picks.durpeesquid.com` as a domain and a CNAME in Cloudflare (DNS only), as in the main README.
6. **Icon (optional):** `picks` has an icon in the main site's `site/project-icons.js`; without it the card shows an initial.

## Keeping it current

`sync-games` runs on a 2-minute schedule and does only what is needed: while games are in progress it refreshes the
current week every 15 seconds; otherwise every 30 minutes; and every 6 hours it refreshes every week of this season
**and the next one**. So a new season's schedule appears when ESPN publishes it, playoff rounds appear as their
matchups are set (undecided "TBD" matchups are skipped), and weeks unlock as the previous one ends. ESPN's API is
unofficial and rejects some default client user agents (the function sends a browser-style one), so if its behaviour ever changes, `supabase/functions/sync-games/index.ts` is the only file to adjust.

## Local dev

- `npm run dev:mock` serves the site with a fake sign-in and an in-memory copy of the data (`dev/`), so every page can be
  tried without Supabase. Nothing in `dev/` is deployed.
- `npm run dev` serves the real site (needs `.env.local` with the two Supabase vars). Login lives on durpeesquid.com
  and the session cookie is not shared with `localhost`, so sign-in only works on a deployed preview or the real subdomain.
- `npm test` runs the real migration in an in-process Postgres (PGlite) and checks the access rules, week unlocking,
  scoring (SQL vs `site/scoring.js`) and the stats views. The test dependencies live in `test/` so Vercel never installs them.
