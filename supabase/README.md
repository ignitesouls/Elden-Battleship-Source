# Database

Postgres on Supabase, with row-level security doing the work a game server would normally do.
There is no backend process refereeing a match. See the main [README](../README.md).

## Layout

```
supabase/
├── config.toml       Supabase CLI project config
├── schema.sql        the full schema as one file, for reading
├── migrations/       the source of truth, applied in filename order
├── functions/        edge functions (Deno)
└── maintenance/      one-off operational SQL, never applied automatically
```

**`migrations/` is authoritative.** Every change to the database is a file in there, named
`YYYYMMDDHHMMSS_description.sql`, applied in order and never edited once applied. If a
migration turns out to be wrong, the fix is another migration. Editing history means the
database and this directory stop agreeing, and there is no way to tell which one is right.

**`schema.sql` is for reading, not applying.** It is the whole schema in one place, which is
far easier to answer a question from than thirty migrations. It can drift, and when the two
disagree the migrations are correct.

**`maintenance/` is not migrations.** These are destructive operational scripts, such as
wiping the record books or striking one player from one match. They are kept because they are
needed occasionally and are easy to get wrong when written under pressure. Read them before
running them. Each one explains what it deletes and what it leaves standing.

## Applying migrations

With the [Supabase CLI](https://supabase.com/docs/guides/cli), linked to the project:

```bash
supabase db push
```

Or by hand, which is how this project has usually done it: open the SQL Editor, paste one
file, run it, then move to the next. **One file per run.** The editor wraps a paste in a
single transaction, so a failure anywhere rolls back everything in it, including the parts
that worked.

Everything here is written to be idempotent (`create ... if not exists`, policies dropped
before being created), so re-running a file that half-worked is safe.

## Status

Applied up to and including `20260803010000_host_can_rename_players`.

Outstanding:

- `20260803020000_players_replica_identity`, which makes a kicked player's removal arrive over
  Realtime instead of on their next reload. One `alter table`, safe to run any time.
- `20260806000000_deep_water_hides`, which moves the placing of everything hiding in the water
  into the database, so it can be kept off squares the fleets are sitting on. Until it is run,
  matches simply have nothing hidden in them - the app degrades rather than breaking.
- `20260813000000_captain_handoff`, which adds `hand_over_captaincy()` behind the lobby's "Make
  captain" button, and stops `team_joined_at` being backdated mid-match. Until it is run that
  button fails with a message saying so; nothing else changes.
- `20260814000000_board_balance`, which adds `rooms.board_perm` and `match_events.board_perm`,
  guards the first against being written by anyone but the balancer, and restamps
  `archive_match()` to record it. Pairs with the `balance-board` edge function: until both are
  in place boards are dealt exactly as they are today, unbalanced, and nothing else changes.
  Run the migration before deploying the function - the function's only write is that column.

## Checking it

`scripts/` holds scripts that exercise the live database directly, each creating and deleting
its own throwaway room:

```bash
node scripts/check-double-shots.mjs    # one square wounds a hull once, however many fleets fire at it
node scripts/check-square-counts.mjs   # shared square tallies, and the RLS around them
node scripts/check-host-powers.mjs     # what a host may and may not do to other players
node scripts/check-kick-realtime.mjs   # the DELETE-over-Realtime problem above
node scripts/check-captain-handoff.mjs # who may hand a fleet's command on, and when
```

They need `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` for cleanup. That key is not public and
must never be committed. The `anon` key that ships in the browser bundle is a different thing
and is public by design.
