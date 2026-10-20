-- The sync-games Edge Function proves who is calling with a shared secret kept in Supabase Vault
-- (secret name: picks_sync_secret). The function checks it through this helper, so the secret
-- never needs to be copied into function environment variables.
create function picks.sync_authorized(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_secret <> '', false) and exists (
    select 1 from vault.decrypted_secrets s
    where s.name = 'picks_sync_secret' and s.decrypted_secret = p_secret
  )
$$;
revoke all on function picks.sync_authorized(text) from public, anon, authenticated;
grant execute on function picks.sync_authorized(text) to service_role;
