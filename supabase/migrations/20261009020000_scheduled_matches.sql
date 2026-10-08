-- Official matches on the front page: what is scheduled, and what is being played right now.
--
-- Captains agree a time for their match (set_match_time) and the front page lists it at the bottom, so a
-- visitor can see what is coming up across every running event - and, once the two teams are in an
-- official room, jump in to spectate it or open both teams' streams side by side on Multitwitch.
--
-- One function, one request. The front page is the busiest page on the site and every API request is a
-- line in the metered log, so this does not become the five or six queries it would take from the browser
-- (matches, teams, rosters, profiles, rooms): it gathers all of it here and returns only what is shown.
-- Definer because it reads across those tables, but it returns nothing a visitor could not already read
-- for themselves - live, non-test events only, approved teams, and public profile fields.
--
-- What is listed:
--   * matches still to be decided ('ready' or 'in_progress') with an agreed time from six hours ago on -
--     a match that started a few hours ago is likely still being played;
--   * and any match with an official room linked to it right now, agreed time or not - it is on.
-- Soonest first, at most p_limit of them.

create or replace function public.scheduled_official_matches(p_limit int default 12)
returns table (
  match_id      uuid,
  tournament_id uuid,
  event_name    text,
  team_size     int,
  stage         text,
  phase         int,
  best_of       int,
  score_a       int,
  score_b       int,
  status        text,
  agreed_at     timestamptz,
  team_a        uuid,
  team_a_name   text,
  team_a_logo   text,
  team_a_avatar text,
  streams_a     text[],
  team_b        uuid,
  team_b_name   text,
  team_b_logo   text,
  team_b_avatar text,
  streams_b     text[],
  room_code     text
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select m.*, t.name as event_name, t.team_size,
           (select r.code from rooms r where r.tournament_match_id = m.id order by r.created_at desc limit 1) as room_code
      from tournament_matches m
      join tournaments t on t.id = m.tournament_id
     where t.status = 'live'
       and not t.is_test
       and m.status in ('ready', 'in_progress')
       and m.entrant_a is not null
       and m.entrant_b is not null
  )
  select c.id, c.tournament_id, c.event_name, c.team_size, c.stage, coalesce(c.phase, c.round), c.best_of,
         c.score_a, c.score_b, c.status, c.agreed_at,
         ea.id, ea.name, ea.logo_path,
         (select p.avatar_url from profiles p where p.id = ea.captain_user_id),
         (select coalesce(array_agg(p.twitch_login order by r.is_captain desc, r.joined_at), '{}')
            from tournament_roster r join profiles p on p.id = r.user_id
           where r.entrant_id = ea.id and p.twitch_login is not null),
         eb.id, eb.name, eb.logo_path,
         (select p.avatar_url from profiles p where p.id = eb.captain_user_id),
         (select coalesce(array_agg(p.twitch_login order by r.is_captain desc, r.joined_at), '{}')
            from tournament_roster r join profiles p on p.id = r.user_id
           where r.entrant_id = eb.id and p.twitch_login is not null),
         c.room_code
    from candidates c
    join tournament_entrants ea on ea.id = c.entrant_a
    join tournament_entrants eb on eb.id = c.entrant_b
   where c.room_code is not null
      or (c.agreed_at is not null and c.agreed_at > now() - interval '6 hours')
   -- A match being played now first, then the soonest.
   order by (c.room_code is null), c.agreed_at nulls last
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

grant execute on function public.scheduled_official_matches(int) to anon, authenticated;
