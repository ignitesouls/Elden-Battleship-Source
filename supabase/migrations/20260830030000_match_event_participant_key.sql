-- Who fired a shot, as one string the database can be asked about.
--
-- -- The problem this solves ------------------------------------------------------------------------
--
-- A career page at /player/<key> shows five things - pace, median square pace, best kills, the kill
-- log, and the match list - and every one of them depends only on that ONE player's shots. It was
-- reading the entire global event log to get them: every shot ever fired by everybody, downloaded so
-- that the browser could throw away all but one player's rows. That is the largest single read on the
-- public site, and it is paid by a cold visitor following a link out of Twitch chat.
--
-- The reason it could not simply filter server-side is that a career is not keyed on a column. It is
-- keyed on `participantKey` in lib/careerStats:
--
--     user_id ?? `name:${nickname.trim().toLowerCase()}`
--
-- Signed-in captains are a plain uuid and could always have been filtered on `user_id`. Guests are
-- the awkward half: their identity is a folded nickname, and `lower(trim(...))` is not something
-- PostgREST can express in a query. So the fold moves into the table, where it can be indexed.
--
-- -- Why a generated column rather than a written one ------------------------------------------------
--
-- Because it cannot then disagree with the row it describes. A column written by archive_match would
-- have to be kept correct at the insert site forever, and any row inserted by an older client - or by
-- a repair script, or by hand - would carry a key that was wrong or absent, which shows up as a
-- career page that is silently missing matches. Generated STORED means Postgres computes it from
-- `user_id` and `nickname` on every insert and update, including for the rows already in the table,
-- and there is no code path that can skip it.
--
-- Every function in the expression is immutable, which is what a generated column requires:
-- `coalesce`, the uuid-to-text cast, `lower` and `btrim` all qualify.
--
-- -- The one place this can still disagree with the client -------------------------------------------
--
-- `btrim` strips ASCII spaces; JavaScript's `.trim()` strips every Unicode space, and the two `lower`
-- implementations can differ on exotic alphabets. A nickname ending in a non-breaking space would
-- therefore fold to a different key here than it does in the browser.
--
-- That is handled on the client rather than papered over here, and deliberately: lib/profiles
-- fetchPlayerEvents falls back to the old whole-log read whenever the filtered one comes back empty.
-- So a key that does not match costs one visitor one expensive page load - exactly what every visitor
-- paid before - instead of an empty career page. The same fallback is what makes the client safe to
-- deploy before this migration is applied.
alter table match_events
  add column if not exists participant_key text
  generated always as (coalesce(user_id::text, 'name:' || lower(btrim(nickname)))) stored;

-- Composite, and in this order, because the read is always "one player's rows, newest first" - see
-- fetchAllRows, which orders by finished_at then id so that its pagination is stable. An index on
-- participant_key alone would find the rows and then make Postgres sort them.
create index if not exists match_events_participant_idx
  on match_events (participant_key, finished_at desc, id desc);
