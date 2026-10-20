-- One-time setup: ask the sync-games Edge Function to run every 2 minutes. It decides by itself
-- whether there is anything to do (see supabase/functions/sync-games/index.ts), so most runs end
-- immediately. Run this in the Supabase SQL editor after deploying the function.
--
-- 1. Pick a long random string and set it as the function's secret:
--      supabase secrets set SYNC_SECRET=<the string>
-- 2. Replace <the string> and <project-ref> below, then run the whole file.
--
-- This is not a migration because it contains a secret and your project URL.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- the secret lives in Supabase Vault, not in the job's text
select vault.create_secret('<the string>', 'picks_sync_secret');

select cron.schedule(
  'picks-sync-games',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/sync-games',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'picks_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Load history once (e.g. the last few seasons). Run from a terminal, not the SQL editor:
--   curl -X POST https://<project-ref>.supabase.co/functions/v1/sync-games \
--        -H "x-sync-secret: <the string>" -H "content-type: application/json" \
--        -d '{"seasons":[2023,2024,2025]}'
--
-- To stop the schedule:  select cron.unschedule('picks-sync-games');
