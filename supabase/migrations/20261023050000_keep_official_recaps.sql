-- Tournament games keep their recap for good.
--
-- prune_stale_rooms() deletes every match_reports row after 30 days: recaps are bulky prose, and an
-- everyday game's stats rows (match_participants, match_events, match_fleets) are kept without it. An
-- official game is different. Its report is the only link from a bracket match to the games played in
-- it (match_reports.tournament_match_id), which the event page uses to open each result's recap, and a
-- tournament's games are the record people come back to. They are also a sliver of the archive, so
-- keeping them costs next to nothing.
--
-- The function is reproduced in full from 20260922010000_official_matches (create or replace cannot
-- patch a body). The only change is the `and not official` marked below.
create or replace function public.prune_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with activity as (
    select
      r.id,
      r.status,
      r.tournament_match_id,
      greatest(
        r.created_at,
        coalesce((select max(a.created_at) from attacks a where a.room_id = r.id), r.created_at),
        coalesce((select max(p.joined_at)  from players p where p.room_id = r.id), r.created_at)
      ) as last_active
    from rooms r
  ),
  dead as (
    delete from rooms r
    using activity act
    where act.id = r.id
      and act.last_active < case
            when act.tournament_match_id is not null then now() - interval '3 days'
            when act.status = 'finished' then now() - interval '10 minutes'
            else now() - interval '1 hour'
          end
    returning 1
  )
  select count(*) into removed from dead;

  -- CHANGED: official reports are never swept.
  delete from match_reports where finished_at < now() - interval '30 days' and not official;

  return removed;
end;
$$;

revoke all on function public.prune_stale_rooms() from public;

-- Official games swept before this: their stats rows are still there, their recap is not, and nothing
-- can bring it back. Counted so the push says how many (the event page shows the tale of the tape for
-- those, as before).
do $$
declare
  lost integer;
begin
  select count(distinct mp.match_key) into lost
    from match_participants mp
   where mp.official
     and not exists (select 1 from match_reports r where r.match_key = mp.match_key);
  raise notice 'Official games whose recap was already swept: %', lost;
end;
$$;
