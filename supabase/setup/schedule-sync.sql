-- Schedules the sync-games Edge Function to run every minute (pg_cron + pg_net). The function decides
-- by itself whether there is anything to do (see supabase/functions/sync-games/index.ts), so most runs
-- end immediately. This is already applied to the DurpeeSquid project; keep it for rebuilding elsewhere.
-- It is not a migration because it contains the project URL. Replace <project-ref> and run it once.
--
-- The shared secret is generated inside the database and kept in Supabase Vault (name: picks_sync_secret).
-- Nobody needs to see it: the cron job reads it from the vault and the function checks it through
-- picks.sync_authorized() (migration 20261020010000_picks_sync_auth.sql).

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'picks_sync_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'picks_sync_secret',
                                'Shared secret for the picks sync-games function');
  end if;
end $$;

select cron.schedule(
  'picks-sync-games',
  '* * * * *',
  $job$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/sync-games',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'picks_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);

-- Load history (one season per call keeps each request short). Results land in net._http_response:
--   select net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/sync-games',
--     headers := jsonb_build_object('content-type','application/json',
--       'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'picks_sync_secret')),
--     body := '{"seasons":[2024]}'::jsonb, timeout_milliseconds := 120000);
--   select id, status_code, content from net._http_response order by id desc limit 5;
--
-- To stop the schedule:  select cron.unschedule('picks-sync-games');
