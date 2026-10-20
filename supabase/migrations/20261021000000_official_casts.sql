-- Official casters for official matches.
--
-- Anyone signed in with Twitch can ask to cast an official match; an administrator approves or declines
-- it on the event desk. An approved caster's Twitch is linked wherever the match's Multitwitch is - the
-- front page card, the event page's "Your next match", and Crew Quarters - as its own button: the grid
-- stays the players' own streams.
--
-- One match at a time, not a whole event: a caster asks for the matches they can make. A match can have
-- several approved casters (co-casters, or a cast in another language), each with a button.
--
-- Players on either team cannot ask to cast their own match - their stream is already in the Multitwitch.
--
-- A request is one row per caster per match, and only these functions write it:
--   request_cast   pending; a withdrawn request may be asked again, a declined one may not
--   withdraw_cast  the caster backs out, pending or approved
--   decide_cast    an administrator approves, declines, or takes back an approval (declined)
--
-- Who can read a row: anyone, once it is approved (it is on the front page); the caster their own, at
-- any status, so the button can say "waiting for approval"; administrators all of them. And only rows of
-- an event the reader can see - the tournaments policy decides that, so drafts and test events stay hidden.
--
-- The caster's Twitch login and name are copied onto the row when they ask, as the roster does with a
-- player's name: the front page reads them without a join, and the desk shows who asked even if they
-- later rename.

create table if not exists public.official_casts (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references public.tournaments(id) on delete cascade,
  match_id        uuid not null references public.tournament_matches(id) on delete cascade,
  caster_user_id  uuid not null,
  twitch_login    text not null,
  display_name    text not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid,
  unique (match_id, caster_user_id)
);

create index if not exists official_casts_tournament_idx on public.official_casts (tournament_id, status);

alter table public.official_casts enable row level security;

drop policy if exists "official casts select" on public.official_casts;
create policy "official casts select" on public.official_casts for select
  using (
    (status = 'approved' or caster_user_id = auth.uid() or public.is_admin())
    and exists (select 1 from public.tournaments t where t.id = tournament_id)
  );

-- No insert, update or delete policies: the functions below are the only way in.

create or replace function public.request_cast(p_match uuid)
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
begin
  if uid is null then
    raise exception 'Sign in with Twitch to ask to cast a match';
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
       set status = 'pending', twitch_login = me_login, display_name = coalesce(me_name, me_login),
           created_at = now(), decided_at = null, decided_by = null
     where match_id = p_match and caster_user_id = uid;
  else
    insert into official_casts (tournament_id, match_id, caster_user_id, twitch_login, display_name)
    values (m.tournament_id, p_match, uid, me_login, coalesce(me_name, me_login));
  end if;
end;
$$;

grant execute on function public.request_cast(uuid) to authenticated;

create or replace function public.withdraw_cast(p_match uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update official_casts set status = 'withdrawn', decided_at = now(), decided_by = auth.uid()
   where match_id = p_match and caster_user_id = auth.uid() and status in ('pending', 'approved');
  if not found then
    raise exception 'You have no cast to withdraw for this match';
  end if;
end;
$$;

grant execute on function public.withdraw_cast(uuid) to authenticated;

create or replace function public.decide_cast(p_cast uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
  m_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can approve or decline a cast';
  end if;
  select c.status, tm.status into was, m_status
    from official_casts c join tournament_matches tm on tm.id = c.match_id
   where c.id = p_cast for update of c;
  if was is null then
    raise exception 'There is no such cast request';
  end if;
  if was = 'withdrawn' then
    raise exception 'The caster has withdrawn this request';
  end if;
  if p_approve and m_status not in ('ready', 'in_progress') then
    raise exception 'That match isn''t waiting to be played any more';
  end if;

  update official_casts
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = now(), decided_by = auth.uid()
   where id = p_cast;
end;
$$;

grant execute on function public.decide_cast(uuid, boolean) to authenticated;

-- The front page's "Tournament matches" card gains the approved casters and the caller's own request.
--
-- Same function, same one request, two more columns:
--   casters   approved casters, earliest asked first, as [{login, name}] - '[]' with none.
--   my_cast   the caller's own request for the match - pending, approved, declined or withdrawn - or
--             null (also for a visitor who isn't signed in), so the card can offer the right button.
--
-- The return type changes, so the function is dropped and made again; the grant goes with it.
-- Everything else is 20261019010000_scheduled_matches_records unchanged.

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
         (select coalesce(jsonb_agg(jsonb_build_object('login', oc.twitch_login, 'name', oc.display_name) order by oc.created_at), '[]'::jsonb)
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
