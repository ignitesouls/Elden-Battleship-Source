-- The front page's "Tournament matches" card shows each team's record in the event and, for a group
-- match, which group it is.
--
-- Same function, same one request (the front page is the busiest page, and every request is a metered
-- log line), with five more columns:
--   grp, group_name   the group a group-stage match belongs to (counting from 0), and the name an
--                     administrator gave it - null when unnamed, and the page shows "Group A" as everywhere.
--   won_a/lost_a,     each team's series won and lost in this event so far, against a real opponent - the
--   won_b/lost_b      same count as Crew Quarters and the tale of the tape (record.ts): byes left out.
--
-- The return type changes, so the function is dropped and made again; the grant goes with it.

drop function if exists public.scheduled_official_matches(int);

create function public.scheduled_official_matches(p_limit int default 12)
returns table (
  match_id      uuid,
  tournament_id uuid,
  event_name    text,
  team_size     int,
  stage         text,
  phase         int,
  grp           int,
  group_name    text,
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
  won_a         int,
  lost_a        int,
  team_b        uuid,
  team_b_name   text,
  team_b_logo   text,
  team_b_avatar text,
  streams_b     text[],
  won_b         int,
  lost_b        int,
  room_code     text
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select m.*, t.name as event_name, t.team_size, t.group_names,
           (select r.code from rooms r where r.tournament_match_id = m.id order by r.created_at desc limit 1) as room_code
      from tournament_matches m
      join tournaments t on t.id = m.tournament_id
     where t.status = 'live'
       and not t.is_test
       and m.status in ('ready', 'in_progress')
       and m.entrant_a is not null
       and m.entrant_b is not null
  ),
  listed as (
    select c.*
      from candidates c
     where c.room_code is not null
        or (c.agreed_at is not null and c.agreed_at > now() - interval '6 hours')
     -- A match being played now first, then the soonest.
     order by (c.room_code is null), c.agreed_at nulls last
     limit greatest(1, least(coalesce(p_limit, 12), 50))
  ),
  -- Every finished series with two teams in it, once per team, in the events being listed.
  results as (
    select d.tournament_id, s.entrant, coalesce(d.winner = s.entrant, false) as won
      from tournament_matches d
      cross join lateral (values (d.entrant_a), (d.entrant_b)) as s(entrant)
     where d.status = 'done'
       and d.entrant_a is not null
       and d.entrant_b is not null
       and d.tournament_id in (select l.tournament_id from listed l)
  ),
  records as (
    select r.tournament_id, r.entrant,
           count(*) filter (where r.won)::int as won,
           count(*) filter (where not r.won)::int as lost
      from results r
     group by r.tournament_id, r.entrant
  )
  select c.id, c.tournament_id, c.event_name, c.team_size, c.stage, coalesce(c.phase, c.round),
         case when c.stage = 'group' then c.grp end,
         case when c.stage = 'group' and c.grp is not null then nullif(trim(c.group_names[c.grp + 1]), '') end,
         c.best_of, c.score_a, c.score_b, c.status, c.agreed_at,
         ea.id, ea.name, ea.logo_path,
         (select p.avatar_url from profiles p where p.id = ea.captain_user_id),
         (select coalesce(array_agg(p.twitch_login order by r.is_captain desc, r.joined_at), '{}')
            from tournament_roster r join profiles p on p.id = r.user_id
           where r.entrant_id = ea.id and p.twitch_login is not null),
         coalesce(ra.won, 0), coalesce(ra.lost, 0),
         eb.id, eb.name, eb.logo_path,
         (select p.avatar_url from profiles p where p.id = eb.captain_user_id),
         (select coalesce(array_agg(p.twitch_login order by r.is_captain desc, r.joined_at), '{}')
            from tournament_roster r join profiles p on p.id = r.user_id
           where r.entrant_id = eb.id and p.twitch_login is not null),
         coalesce(rb.won, 0), coalesce(rb.lost, 0),
         c.room_code
    from listed c
    join tournament_entrants ea on ea.id = c.entrant_a
    join tournament_entrants eb on eb.id = c.entrant_b
    left join records ra on ra.tournament_id = c.tournament_id and ra.entrant = c.entrant_a
    left join records rb on rb.tournament_id = c.tournament_id and rb.entrant = c.entrant_b
   order by (c.room_code is null), c.agreed_at nulls last;
$$;

grant execute on function public.scheduled_official_matches(int) to anon, authenticated;
