-- The front page in one request.
--
-- The front page is the screen people leave open, and it used to poll four reads on three timers: live
-- battles (rooms, then players - two requests every 20s), the event banners (every 60s) and the
-- scheduled official matches (every 120s). About 450 requests an hour per open tab. Supabase meters log
-- ingest by the line from 2027 and every REST request is a line, so request COUNT is the budget.
--
-- front_page() answers all three in one jsonb object, polled once (see hooks/useFrontPageFeed):
--
--   live       battles being fought now, newest first, with head and fleet counts. Deliberately
--              status = 'battle' and nothing else: a lobby or placement is not a thing to walk in on, and
--              listing them would make the front page a directory of rooms to gatecrash; 'finished' is
--              over. rooms/players are world-readable, so this shows nothing a room code doesn't.
--   events     every event a banner can be made from: open and running ones, and finished ones still inside
--              their champion window - test events never
--   scheduled  scheduled_official_matches(p_limit), rows unchanged and in its order
--
-- SECURITY INVOKER on purpose: rooms, players, tournaments and entrants are read under the caller's own
-- policies, exactly as the four separate reads were, so it shows nobody anything new.
-- scheduled_official_matches stays security definer, as before; its my_cast is still the caller's,
-- since auth.uid() carries through.
--
-- The champion window is the caller's CHAMPION_BANNER_DAYS (frontPage.ts), passed in so the number has
-- one home; the cutoff itself is taken from the database's clock, which beats any browser's.

create or replace function public.front_page(p_champion_days int default 14, p_limit int default 12)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'live', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', r.code,
               'created_at', r.created_at,
               'practice', coalesce(r.practice, false),
               'players', (select count(*) from players p where p.room_id = r.id),
               'fleets', (select count(distinct p.team) from players p where p.room_id = r.id and p.team is not null)
             ) order by r.created_at desc)
        from rooms r
       where r.status = 'battle'
    ), '[]'::jsonb),

    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'name', e.name,
               'status', e.status,
               'signup_closes_at', e.signup_closes_at,
               'starts_at', e.starts_at,
               'finished_at', e.finished_at,
               'logo_path', e.logo_path,
               'champion_name', e.champion_name
             ) order by e.created_at desc)
        from (
          select t.*, c.name as champion_name
            from tournaments t
            left join tournament_entrants c on c.id = t.champion_id
           where not t.is_test
             and (t.status in ('signup', 'live')
                  or (t.status = 'finished'
                      and t.finished_at >= now() - make_interval(days => greatest(coalesce(p_champion_days, 14), 0))))
           order by t.created_at desc
           limit 20
        ) e
    ), '[]'::jsonb),

    'scheduled', coalesce((
      select jsonb_agg(to_jsonb(s) - 'ordinality' order by s.ordinality)
        from public.scheduled_official_matches(p_limit) with ordinality as s
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.front_page(int, int) to anon, authenticated;


-- The egress meter, retired.
--
-- egress_samples, record_egress_sample and the egress_by_room view were the measuring half of an egress
-- study (20260830020000_egress_samples.sql). The client meter and the admin Egress panel were deleted on
-- 2026-10-19 and nothing has written or read them since; the egress-usage edge function goes with them
-- (deleted from the project separately - functions are not migrations).
drop view if exists public.egress_by_room;
drop function if exists public.record_egress_sample(uuid, text, text, bigint, integer, integer, bigint, integer);
drop table if exists public.egress_samples;
