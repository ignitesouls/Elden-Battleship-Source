-- Site administrators: who may edit and delete the record books, and who may appoint others.
--
-- Until now the archive tables carried SELECT and INSERT policies only, so wiping a bad match
-- meant pasting SQL into the dashboard. That's fine once; it's the wrong tool for something that
-- will happen every time a test game gets recorded by accident.
--
-- Two tiers, because "can delete stats" and "can appoint people who can delete stats" are very
-- different powers:
--
--   owner  - the account that runs the site. Can do everything, and is the only tier that can
--            appoint or remove another owner. Seeded here and never grantable from the app.
--   admin  - can edit and delete records, and can grant/revoke ordinary admin.
--
-- The distinction exists so that appointing someone can't backfire: an admin who turns out to be
-- careless (or hostile) can be removed by the owner, and cannot pre-emptively remove the owner.

create table if not exists admins (
  user_id     uuid primary key,
  -- Cached at grant time so the roster still reads sensibly if a profile row is ever removed.
  display_name text,
  is_owner    boolean not null default false,
  granted_by  uuid,
  granted_at  timestamptz not null default now()
);

alter table admins enable row level security;

-- -- Helpers ----------------------------------------------------------------
-- SECURITY DEFINER is load-bearing, not decoration. The policies on `admins` below call these,
-- and those calls read `admins` - if they ran under the caller's rights, evaluating the policy
-- would re-trigger the policy and recurse forever. Running as the owner skips RLS and breaks the
-- cycle. STABLE so Postgres evaluates them once per statement rather than once per row.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins a where a.user_id = auth.uid());
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins a where a.user_id = auth.uid() and a.is_owner);
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_owner() to anon, authenticated;

-- -- Who can see and change the roster --------------------------------------

-- Your own row is always visible - that's how the app answers "am I an admin?" without publishing
-- the roster to everyone. Admins additionally see the whole list, because they manage it.
drop policy if exists "admins select" on admins;
create policy "admins select" on admins for select
  using (user_id = auth.uid() or public.is_admin());

-- Admins may appoint other admins, but NOT owners: `is_owner` must be false on anything inserted
-- unless an owner is doing the inserting. Without that clause any admin could quietly promote
-- themselves to a tier that only owners can undo.
drop policy if exists "admins insert by admin" on admins;
create policy "admins insert by admin" on admins for insert
  with check (
    public.is_admin()
    and (is_owner = false or public.is_owner())
  );

-- Revoking: an ordinary admin can remove another ordinary admin; only an owner can remove an
-- owner. This is what stops an appointed admin from locking the site's actual operator out.
drop policy if exists "admins delete by admin" on admins;
create policy "admins delete by admin" on admins for delete
  using (
    public.is_admin()
    and (is_owner = false or public.is_owner())
  );

-- -- What admins may do to the record books ---------------------------------
-- DELETE and UPDATE only. INSERT stays open to everyone, because that's how a finished match
-- archives itself from the players' own browsers.

drop policy if exists "match_reports delete by admin" on match_reports;
create policy "match_reports delete by admin" on match_reports for delete using (public.is_admin());
drop policy if exists "match_reports update by admin" on match_reports;
create policy "match_reports update by admin" on match_reports for update using (public.is_admin());

drop policy if exists "match_participants delete by admin" on match_participants;
create policy "match_participants delete by admin" on match_participants for delete using (public.is_admin());
drop policy if exists "match_participants update by admin" on match_participants;
create policy "match_participants update by admin" on match_participants for update using (public.is_admin());

drop policy if exists "match_fleets delete by admin" on match_fleets;
create policy "match_fleets delete by admin" on match_fleets for delete using (public.is_admin());

drop policy if exists "match_events delete by admin" on match_events;
create policy "match_events delete by admin" on match_events for delete using (public.is_admin());

-- Rooms too. There has never been a DELETE policy on `rooms`, so a room that outlived its match
-- could only be removed by prune_stale_rooms() on its own schedule - which meant a stuck or
-- unwanted room held one of the 15 slots until the pruner got to it, with no way to intervene.
drop policy if exists "rooms delete by admin" on rooms;
create policy "rooms delete by admin" on rooms for delete using (public.is_admin());

-- -- Seed the owner ---------------------------------------------------------
-- KCBrazos, resolved from the Twitch profile rather than pasted as a bare uuid, so this stays
-- readable and survives the account being recreated. Idempotent: re-running promotes nothing and
-- overwrites nothing except the cached display name.
insert into admins (user_id, display_name, is_owner, granted_by)
select p.id, p.display_name, true, p.id
  from profiles p
 where p.twitch_id = '139068303'
on conflict (user_id) do update
  set is_owner = true,
      display_name = excluded.display_name;
