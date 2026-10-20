# Durpee Squid Game Picks

Pick the final score of every NFL game, keep your history forever, and compare yourself with everyone else.

Zero npm dependencies: Node 22.13+ (built-in SQLite), a small HTTP server, and a vanilla-JS single-page app.

## Always up to date, no manual steps

Schedules and results come from ESPN's public scoreboard API. While the server runs it:

- re-syncs the current season **and the next one** every 30 min (every 2 min while games are in progress), so new weeks, playoff rounds (as matchups are set) and next year's schedule appear on their own, forever;
- unlocks weeks one at a time: a week accepts picks only after every earlier week (across seasons) has ended, and each game still locks at its own kickoff. A week counts as ended when all its games are final, or 3 days after its last kickoff, so a postponed game can't block the schedule;
- can load history on first start with `BACKFILL_FROM=2020`.

ESPN's API is unofficial and undocumented, so if it ever changes, `lib/espn.js` is the only file to adjust.

## Run it

```bash
npm run sync -- 2024 2025     # backfill seasons (the server also syncs the current season on its own)
npm start                     # http://localhost:3000
npm run demo                  # optional: fake players with picks (password "demopass123") so every page has data
npm test
```

Environment: `PORT` (3000), `DB_PATH` (`data/picks.db`), `SYNC_MINUTES` (30, `0` disables), `LIVE_SYNC_MINUTES` (2), `BACKFILL_FROM` (off), `COOKIE_SECURE=1` (set when served over HTTPS).

## Features

- **Picks**: predict both scores for every game of the open week; games lock at kickoff. Others can only see your pick after kickoff.
- **History**: every season and week you have ever played, each with your picks next to the real results.
- **Leaderboards**: all time, per season, or a single week, ranked by points, avg points, winner %, margin error or exact scores.
- **Search**: best/worst weeks and seasons (any player, any metric), and a pick explorer (biggest misses, closest calls, exact scores, blowouts, by team/player/season).
- **Stats**: per player and per team (accuracy, average margin and total-score error, picked-to-win % vs actual win %, longest streak, home-pick bias); a community "most overrated team" table.

## Scoring (max 20 per game)

| | Points |
|---|---|
| Right winner (or a correctly called tie) | 10 |
| Margin bonus | 5 minus how far your predicted margin was off (min 0) |
| Exact score | +5 |

Scores are computed from picks and results on read, so changing `lib/scoring.js` re-scores all history.

## Security notes

- Passwords are hashed with scrypt; sessions are random tokens stored hashed, in HttpOnly SameSite=Lax cookies.
- State-changing requests must be `application/json` (blocks cross-site form posts); login/register are rate limited.
- Picks are validated and locked server-side at kickoff; the client is never trusted.
- The database lives in `data/` and is git-ignored. Never commit it or any `.env` file.
