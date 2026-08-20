-- One permanent token per player, so a program running on their machine can fire their shots.
--
-- -- Why a token rather than a session -----------------------------------------------------------
--
-- The auto-fire client is a native mod loaded into Elden Ring, reading its settings from a plaintext
-- config file next to the DLL. It cannot hold a Supabase session: there is nowhere safe to keep one,
-- nothing to refresh it, and no browser to sign in from. So it carries an opaque string instead, and
-- the ingest endpoint trades that string for an identity using the service role key.
--
-- -- Why it is keyed on the user, and permanent ---------------------------------------------------
--
-- The obvious design scopes a token to a match. It is also unusable: it would mean generating a new
-- one on the website, alt-tabbing, editing a text file and relaunching the game before every single
-- match. Keyed on the user instead, a player pastes it once and never touches it again.
--
-- Everything match-specific is therefore resolved at fire time rather than baked into the token:
-- the endpoint looks up which room the player is currently in a battle in, and reads their team off
-- the players row that already exists because they joined a fleet. The token itself encodes nothing.
-- Switching teams, joining a different room, or playing five matches back to back all work with no
-- reconfiguration, because none of that is in the token to go stale.
--
-- -- Why this implies Twitch sign-in --------------------------------------------------------------
--
-- "Permanent" is only true if the identity is. Anonymous players get a user_id from
-- signInAnonymously(), which lives in one browser's storage - clear the cache or move machines and
-- they silently become a different user, leaving the token pasted in their config pointing at
-- nothing, with no error anywhere. A Twitch auth.users.id survives both. Nothing here enforces that
-- (a row is a row), but the UI only offers token generation to signed-in accounts, and the reason
-- is this.
--
-- -- Why its own table, and not a column on profiles ----------------------------------------------
--
-- `profiles` is world-readable on purpose - the leaderboard is public, and its select policy is
-- `using (true)`. A secret stored there is a secret handed to anyone who queries the table. This
-- one is readable only by its owner.
--
-- -- Blast radius of a leaked token ---------------------------------------------------------------
--
-- Bounded: it lets someone fire shots as you, in whatever room you happen to be
-- playing in. It grants no reads, reaches no other table, and does nothing at all when you are not
-- mid-match. Regenerating is an update of the token column, which invalidates the old string
-- immediately.

create table if not exists public.ingest_tokens (
  -- 48 hex characters. Long enough that guessing is not a strategy, and no dashes or casing to lose
  -- when it is copied by hand into a config file.
  token       text primary key default encode(gen_random_bytes(24), 'hex'),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),

  -- One live token per person. Regeneration is an update of `token` on this row rather than a second
  -- row, so there is never a set of old tokens quietly still working.
  unique (user_id)
);

alter table public.ingest_tokens enable row level security;

-- No public select policy: unlike every other table here, this one holds a secret. Even the owner
-- reading their own token is scoped to exactly their row, and nobody can enumerate the table.
drop policy if exists "ingest_tokens select own" on public.ingest_tokens;
create policy "ingest_tokens select own" on public.ingest_tokens
  for select using (user_id = auth.uid());

drop policy if exists "ingest_tokens insert own" on public.ingest_tokens;
create policy "ingest_tokens insert own" on public.ingest_tokens
  for insert with check (user_id = auth.uid());

-- Regenerate. `with check` as well as `using` so a row cannot be updated into somebody else's name.
drop policy if exists "ingest_tokens update own" on public.ingest_tokens;
create policy "ingest_tokens update own" on public.ingest_tokens
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "ingest_tokens delete own" on public.ingest_tokens;
create policy "ingest_tokens delete own" on public.ingest_tokens
  for delete using (user_id = auth.uid());

-- The endpoint's only query is token -> user_id, on every reported kill. The primary key already
-- covers it; this is here to say so rather than to add anything.
comment on table public.ingest_tokens is
  'Per-user permanent secret for the auto-fire client. Looked up by the auto-fire edge function with the service role key; never exposed to other players.';
