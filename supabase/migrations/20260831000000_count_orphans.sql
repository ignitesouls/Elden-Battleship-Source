-- Counting orphaned record rows without shipping them to the browser.
--
-- An orphan is a row in one of the three satellite tables whose parent match_reports row is gone.
-- They matter because the admin's match list is built from match_reports, so an orphan is invisible
-- there while still counting on the leaderboard, which aggregates match_participants directly.
--
-- The client used to answer this by downloading the match_key of EVERY row in all three tables and
-- diffing them in JavaScript - match_events holds one row per shot ever fired, so that is tens of
-- thousands of rows fetched on every visit to /admin to produce a single integer. Postgres can
-- answer the same question over the same rows without any of them crossing the wire.
--
-- security definer for the same reason admin_prune_rooms is: the count spans tables whose read
-- policies differ, and the answer is a number rather than any row's contents. The is_admin() gate is
-- the real check - without it this would be a way for anyone to size the archive.

create or replace function public.admin_count_orphans()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select count(*)::integer into n
  from (
    select match_key from match_participants
    union all
    select match_key from match_fleets
    union all
    select match_key from match_events
  ) s
  where not exists (select 1 from match_reports r where r.match_key = s.match_key);

  return n;
end;
$$;

grant execute on function public.admin_count_orphans() to anon, authenticated;
