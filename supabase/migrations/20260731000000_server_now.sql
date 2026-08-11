-- The database's clock, readable by the browser.
--
-- Every shared instant in a match is a Postgres timestamp: the match-start marker in `attacks`,
-- and every attack row after it. The match clock counted elapsed time from that marker to the
-- browser's own Date.now(), which subtracts a server clock from a client clock - so each player's
-- timer was wrong by exactly however wrong their own PC clock was. An unsynced Windows clock drifts
-- minutes, and players in the same room were seeing timers minutes apart.
--
-- It decided who could shoot, too. `canFire` is derived from the same phase calculation, so a fast
-- clock opened fire early and a slow one stayed locked out after everyone else had started - a
-- fairness bug, not just a display one.
--
-- With this the client measures its own offset once (round-trip compensated) and adds it to every
-- local reading. now() is the transaction timestamp and exposes nothing else about the database;
-- this is strictly less information than any row already readable through the public policies.
--
-- Safe to re-run. The client treats a missing function as "offset 0" and falls back to the old
-- local-clock behaviour, so deploying the code before applying this degrades rather than breaks.
create or replace function public.server_now() returns timestamptz
  language sql
  stable
  parallel safe
as $$ select now() $$;

grant execute on function public.server_now() to anon, authenticated;

comment on function public.server_now() is
  'Database clock for the shared match timer. Clients measure their own offset against this so every player counts from the same now(); see lib/serverTime.ts.';
