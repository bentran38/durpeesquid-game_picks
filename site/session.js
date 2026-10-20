// The one place the picks pages import the shared sign-in module from. It is served by the main
// site, so a page that loads before that site's newest version is live still works: loadProfile is
// optional and simply returns null when it is missing.
import * as auth from 'https://www.durpeesquid.com/auth.js';

export const { supabase, requireLogin, hasAccess, signOut, HOME } = auth;
export const loadProfile = auth.loadProfile ?? (async () => null);
