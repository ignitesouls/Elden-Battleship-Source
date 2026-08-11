-- A player-chosen nickname that outlives their Twitch display name.
--
-- Until now a signed-in player could not rename themselves at all. The Home nickname box was
-- re-derived from user_metadata.display_name on every load, and useAuthProfile mirrored that same
-- Twitch name straight back into profiles.display_name - so anything they typed lasted exactly one
-- session and the leaderboard never showed it.
--
-- The fix is a second column rather than letting them edit display_name, because display_name has a
-- job: it is the Twitch account's real name, which is how `grantAdmin()` resolves a person
-- (lib/admin.ts) and how someone is identified when their chosen name is unrecognizable. Nickname
-- is the override; null means "no override, use display_name".
alter table profiles add column if not exists nickname text;

-- Mirrors the 20-char cap on the nickname input. Enforced here too because the anon key ships in
-- the JS bundle: without it, a hand-made request could park a 4KB name in a leaderboard cell.
-- Blank is rejected rather than stored - "no nickname" has a representation already, and it is null.
alter table profiles drop constraint if exists profiles_nickname_length;
alter table profiles add constraint profiles_nickname_length
  check (nickname is null or (btrim(nickname) <> '' and char_length(nickname) between 1 and 20));

comment on column profiles.nickname is
  'Player-chosen display override. Null falls back to display_name (the Twitch name). Written only by its owner, via the "profiles update own" policy.';
