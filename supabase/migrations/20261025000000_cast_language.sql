-- Which language an official cast is in: English or French, chosen by the caster when they ask.
--
-- A match can have a cast in each language (a co-cast, or a French stream beside the English one), and
-- a viewer picking a stream wants to know which is which before clicking. The language rides on the
-- cast request and is shown beside the caster's name wherever casters are listed.
--
--   official_casts.language  'en' or 'fr'; every cast asked for before this was English
--   request_cast             takes the language (English if left out, so an older page still works)
--   scheduled_official_matches  each caster in `casters` carries `lang`
--
-- And one correction: on Whimpering Merchants vs Mohg Verry (G1-1-1), Kiofto is casting in French.

alter table public.official_casts
  add column if not exists language text not null default 'en' check (language in ('en', 'fr'));

-- Reproduced from 20261021000000_official_casts.sql. The changes: the language parameter, checked, and
-- written on a new request and on one asked again after a withdrawal.
drop function if exists public.request_cast(uuid);

create or replace function public.request_cast(p_match uuid, p_language text default 'en')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  m record;
  t_status text;
  me_login text;
  me_name text;
  was text;
  lang text := coalesce(p_language, 'en');
begin
  if uid is null then
    raise exception 'Sign in with Twitch to ask to cast a match';
  end if;
  if lang not in ('en', 'fr') then
    raise exception 'A cast is in English or French';
  end if;
  select p.twitch_login, p.display_name into me_login, me_name from profiles p where p.id = uid;
  if me_login is null then
    raise exception 'Sign in with Twitch to ask to cast a match';
  end if;

  select tm.id, tm.tournament_id, tm.status, tm.entrant_a, tm.entrant_b into m from tournament_matches tm where tm.id = p_match;
  if m.id is null then
    raise exception 'There is no such match';
  end if;
  select t.status into t_status from tournaments t where t.id = m.tournament_id;
  if t_status is distinct from 'live' then
    raise exception 'Casts can only be asked for while the event is running';
  end if;
  if m.status not in ('ready', 'in_progress') or m.entrant_a is null or m.entrant_b is null then
    raise exception 'That match isn''t waiting to be played';
  end if;
  if exists (select 1 from tournament_roster r where r.user_id = uid and r.entrant_id in (m.entrant_a, m.entrant_b)) then
    raise exception 'You''re playing in this match - your stream is already in the Multitwitch';
  end if;

  select c.status into was from official_casts c where c.match_id = p_match and c.caster_user_id = uid for update;
  if was = 'pending' then
    raise exception 'You have already asked to cast this match - an administrator will get to it';
  elsif was = 'approved' then
    raise exception 'You are already an official caster for this match';
  elsif was = 'declined' then
    raise exception 'An administrator turned down your cast for this match';
  elsif was = 'withdrawn' then
    update official_casts
       set status = 'pending', twitch_login = me_login, display_name = coalesce(me_name, me_login), language = lang,
           created_at = now(), decided_at = null, decided_by = null
     where match_id = p_match and caster_user_id = uid;
  else
    insert into official_casts (tournament_id, match_id, caster_user_id, twitch_login, display_name, language)
    values (m.tournament_id, p_match, uid, me_login, coalesce(me_name, me_login), lang);
  end if;
end;
$$;

grant execute on function public.request_cast(uuid, text) to authenticated;

-- Reproduced from 20261021000000_official_casts.sql. The one change: each entry of `casters` carries
-- `lang`. The return type is unchanged (casters is jsonb either way), so this replaces it in place.
create or replace function public.scheduled_official_matches(p_limit int default 12)
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
  room_code     text,
  casters       jsonb,
  my_cast       text
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
         c.room_code,
         -- CHANGED: each caster's language.
         (select coalesce(jsonb_agg(jsonb_build_object('login', oc.twitch_login, 'name', oc.display_name, 'lang', oc.language) order by oc.created_at), '[]'::jsonb)
            from official_casts oc
           where oc.match_id = c.id and oc.status = 'approved'),
         (select oc.status from official_casts oc where oc.match_id = c.id and oc.caster_user_id = auth.uid())
    from listed c
    join tournament_entrants ea on ea.id = c.entrant_a
    join tournament_entrants eb on eb.id = c.entrant_b
    left join records ra on ra.tournament_id = c.tournament_id and ra.entrant = c.entrant_a
    left join records rb on rb.tournament_id = c.tournament_id and rb.entrant = c.entrant_b
   order by (c.room_code is null), c.agreed_at nulls last;
$$;

grant execute on function public.scheduled_official_matches(int) to anon, authenticated;

-- Kiofto's cast of Whimpering Merchants vs Mohg Verry (G1-1-1) is in French. By its row id, so this
-- touches that one cast and nothing else; a database without it (a local one) simply updates nothing.
update public.official_casts set language = 'fr' where id = '4aeace18-6328-49bb-abe3-46dcd00d1d8b';
