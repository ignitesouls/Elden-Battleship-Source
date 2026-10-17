-- Tournament records follow a player to their new account, like their career already does.
--
-- Signing in with Twitch on a second browser, or after clearing the cache, lands on a new account id:
-- the twitch-login function's reclaim() moves the player's match history and admin standing from the
-- old id onto the new one and deletes the old profile. It never moved anything tournament-shaped - the
-- tournament tables came later - so the roster, the captaincy and the solo pool kept pointing at an id
-- with no profile. The player still showed on their team by name, but not as a Twitch link, and the
-- site no longer knew them as that team's member or captain (Crew Quarters, agreed times, renaming).
-- Found on LazyHelios and psiphicode (Ship of Theseus) and Drazruin (TBD 2).
--
-- move_account_records() is what reclaim() now calls before it deletes the old profile. Below it, the
-- accounts already left behind are repaired.

create or replace function public.move_account_records(p_old uuid, p_new uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_old is null or p_new is null or p_old = p_new then
    return;
  end if;

  -- The solo pool first: one row per player per event. Where both accounts have one, keep the old row
  -- only if it is the one placed on a team. Done before the roster so that dropping a duplicate roster
  -- row below finds no pool row of the old id to send back to waiting.
  delete from tournament_free_agents n
   using tournament_free_agents o
   where o.user_id = p_old and n.user_id = p_new and n.tournament_id = o.tournament_id
     and o.status = 'placed' and n.status <> 'placed';
  delete from tournament_free_agents o
   using tournament_free_agents n
   where o.user_id = p_old and n.user_id = p_new and n.tournament_id = o.tournament_id;
  update tournament_free_agents set user_id = p_new where user_id = p_old;

  -- Rosters. Both accounts on the same team would collide on the key: keep the new row, and the
  -- captaincy if the old one held it.
  update tournament_roster n
     set is_captain = true
    from tournament_roster o
   where o.user_id = p_old and o.is_captain and n.user_id = p_new and n.entrant_id = o.entrant_id;
  delete from tournament_roster o
   using tournament_roster n
   where o.user_id = p_old and n.user_id = p_new and n.entrant_id = o.entrant_id;
  update tournament_roster set user_id = p_new where user_id = p_old;

  update tournament_entrants set captain_user_id = p_new where captain_user_id = p_old;

  -- Dionysus and overlay tokens: one per account. The old account is never seated in a room again, so
  -- its token can't fire anything; carry it over so the player's Dionysus keeps working, unless the
  -- new account already has its own - then the old one is just a dead secret.
  delete from ingest_tokens o where o.user_id = p_old and exists (select 1 from ingest_tokens n where n.user_id = p_new);
  update ingest_tokens set user_id = p_new where user_id = p_old;
  delete from overlay_tokens o where o.user_id = p_old and exists (select 1 from overlay_tokens n where n.user_id = p_new);
  update overlay_tokens set user_id = p_new where user_id = p_old;
end;
$$;

revoke all on function public.move_account_records(uuid, uuid) from public, anon, authenticated;
grant execute on function public.move_account_records(uuid, uuid) to service_role;

-- -- The accounts already left behind -------------------------------------------------------------
--
-- An orphan is an id on a roster, a captaincy or the pool with no profile: reclaim() deletes the
-- profile and nothing else does. Each is matched to the profile that holds the same player now:
--   1. by Twitch identity - the old account still has its auth.identities row if it signed in through
--      Supabase's own Twitch provider (the first days), and its provider_id is the Twitch user id;
--   2. otherwise by the name it joined under - the roster and pool copy the profile's display name,
--      which is the Twitch display name, so it matches the profile's twitch_login ignoring case. Used
--      only when exactly one profile matches.
-- Anything that matches neither way is left alone and reported.
do $$
declare
  orphan uuid;
  target uuid;
  matches int;
begin
  for orphan in
    select distinct x.u
      from (
        select user_id as u from tournament_roster
        union select captain_user_id from tournament_entrants
        union select user_id from tournament_free_agents
      ) x
     where x.u is not null
       and not exists (select 1 from profiles p where p.id = x.u)
  loop
    select p.id into target
      from auth.identities i
      join profiles p on p.twitch_id = i.provider_id
     where i.user_id = orphan and i.provider = 'twitch'
     limit 1;

    if target is null then
      select count(distinct p.id), min(p.id::text)::uuid into matches, target
        from profiles p
       where lower(p.twitch_login) in (
               select lower(r.display_name) from tournament_roster r where r.user_id = orphan
               union
               select lower(f.display_name) from tournament_free_agents f where f.user_id = orphan
             );
      if matches <> 1 then
        target := null;
      end if;
    end if;

    if target is null then
      raise notice 'No account found for %, left as it is', orphan;
    else
      perform public.move_account_records(orphan, target);
      raise notice 'Moved % onto %', orphan, target;
    end if;
  end loop;
end;
$$;
