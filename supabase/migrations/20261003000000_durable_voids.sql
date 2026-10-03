-- Voids that outlive the 30-day sweep, and voids for matches the sweep has already taken.
--
-- `voided` lives on match_reports, and prune_stale_rooms() deletes every match_reports row older than
-- 30 days - voided ones included. The stats rows (match_participants, match_events, match_fleets)
-- are never swept, so a match keeps counting for ever. Put the two together and:
--
--   * every void silently undid itself after 30 days, and the match it struck started counting
--     again - RUSTYSQUALL, the match voiding was built for, among them;
--   * a match older than 30 days could not be voided at all, because there was no row to set the
--     flag on. That is 163 of the 276 matches in the archive at the time of writing.
--
-- So the judgement moves to a table of its own that the sweep never touches. match_reports.voided
-- stays - the recap page and the admin list read it, and archive_match() writes it for practice
-- matches - and a trigger copies it across, so neither of those writers has to change. Everything
-- that FILTERS on a void now reads voided_matches instead.
--
-- RUSTYSQUALL itself is already gone from match_reports, so it is restored by key below.

create table if not exists public.voided_matches (
  match_key text primary key,
  voided_at timestamptz not null default now(),
  voided_by uuid default auth.uid(),
  -- Why it is struck. A practice match was declared before it was played and never counts - the
  -- sweep used to delete that label along with the report, so a month later the practice run
  -- quietly joined the leaderboard and the Hall of Fame. Kept here so it can't be lost again.
  practice boolean not null default false
);

comment on table public.voided_matches is
  'Matches struck from every stat and record. The durable copy of match_reports.voided, which the 30-day sweep deletes with the report; this table it never touches.';

alter table public.voided_matches enable row level security;

-- Public to read, like the stats it filters: every visitor's stats fetch reads the list.
drop policy if exists "voided_matches select" on public.voided_matches;
create policy "voided_matches select" on public.voided_matches for select using (true);

drop policy if exists "voided_matches insert by admin" on public.voided_matches;
create policy "voided_matches insert by admin" on public.voided_matches for insert with check (public.is_admin());

-- A practice void can never be lifted, the same rule guard_practice_record() enforces on the report
-- (20260830040000_practice_matches.sql) - this table must not become the way around it.
drop policy if exists "voided_matches delete by admin" on public.voided_matches;
create policy "voided_matches delete by admin" on public.voided_matches for delete
  using (public.is_admin() and not practice);

-- Every void still standing on a report, practice matches included.
insert into public.voided_matches (match_key, voided_at, voided_by, practice)
select match_key, coalesce(finished_at, now()), null, coalesce(practice, false)
  from public.match_reports
 where voided
on conflict (match_key) do nothing;

-- And the one void the sweep is known to have taken: RUSTYSQUALL, the match voiding was built for
-- (20260820030000_voided_matches.sql), whose report went at 30 days and which has counted since.
-- Restored here by key, from that migration, so nobody has to re-void it by hand.
--
-- Practice matches need no such restoring. The feature landed on 30 Aug 2026, and at the time of
-- writing every match swept since then is a real two-fleet game of 4-10 captains, so no practice
-- run has lost its label yet - and from here on the label lives in this table, out of the sweep's reach.
insert into public.voided_matches (match_key, voided_at, voided_by, practice)
values ('RUSTYSQUALL:2026-08-15 01:17:56.470891+00', timestamptz '2026-08-20 03:00:00+00', null, false)
on conflict (match_key) do nothing;

-- Keeps the table in step with the flag, for the two writers that set it on the report: the admin
-- panel's Void button (an UPDATE) and archive_match() for a practice match (an INSERT). Security
-- definer so archive_match's caller, who is not an admin, can still record a practice match's void.
create or replace function public.sync_voided_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.voided then
    insert into voided_matches (match_key, practice)
    values (new.match_key, coalesce(new.practice, false))
    on conflict (match_key) do update set practice = voided_matches.practice or excluded.practice;
  elsif tg_op = 'UPDATE' and old.voided then
    -- guard_practice_record() has already refused this for a practice match; the filter is the
    -- belt to its braces.
    delete from voided_matches where match_key = new.match_key and not practice;
  end if;
  return new;
end;
$$;

drop trigger if exists match_reports_sync_voided on public.match_reports;
create trigger match_reports_sync_voided
  after insert or update of voided on public.match_reports
  for each row execute function public.sync_voided_match();

-- The one SQL reader of the flag. Same function as 20260922010000_official_matches.sql, reading the
-- durable table instead - which is the point of the comment above it there, since this was already
-- built on match_participants precisely because it outlives the sweep.
create or replace function public.official_leaderboard()
returns table (player_key text, display_name text, played bigint, wins bigint)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(mp.user_id::text, 'name:' || lower(btrim(mp.nickname))) as player_key,
         coalesce(max(p.display_name), max(mp.nickname)) as display_name,
         count(*) as played,
         count(*) filter (where mp.won) as wins
    from match_participants mp
    left join profiles p on p.id = mp.user_id
   where mp.official
     and not exists (select 1 from voided_matches v where v.match_key = mp.match_key)
   group by 1
   order by wins desc, played asc
   limit 200;
$$;

grant execute on function public.official_leaderboard() to anon, authenticated;
