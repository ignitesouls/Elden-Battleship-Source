-- Team logos.
--
-- A captain can give their team a logo while signup is open - the same window in which they can rename
-- it - and the logo is shown wherever the team is: the team list, the group standings, the bracket.
-- After signup closes it is an administrator's to change or remove, like the name.
--
-- The image lives in Supabase Storage, in a public bucket, under a folder named for the team:
--   team-logos/<entrant id>/<random>.webp
-- Public because a logo is shown to everyone on the event page and fetching it should cost nothing but
-- the image: no signed URL to ask for first. A pending team's logo is "public" only in the sense that its
-- address is a random name nobody can list or guess.
--
-- The app shrinks and re-encodes every upload to a 256px square before it is sent (which also drops
-- whatever metadata a phone photo carries - location included), so the size limit here is a backstop
-- against a tampered page, not the real constraint. A new upload always gets a new name, so a cached
-- old logo can never be shown in place of a new one and the files can be cached for good.

-- ===========================================================================
--  The column
-- ===========================================================================
-- The object's path inside the bucket, or null for no logo. The check pins it to the team's own folder,
-- so no team can point at another team's image, whoever writes the row.
alter table public.tournament_entrants add column if not exists logo_path text;

alter table public.tournament_entrants drop constraint if exists tournament_entrants_logo_path_check;
alter table public.tournament_entrants add constraint tournament_entrants_logo_path_check
  check (logo_path is null or logo_path ~ ('^' || id::text || '/[A-Za-z0-9-]{8,64}\.(webp|png)$'));

comment on column public.tournament_entrants.logo_path is
  'Path of the team''s logo in the team-logos storage bucket (<entrant id>/<random>.webp), or null.';

-- ===========================================================================
--  The bucket
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-logos', 'team-logos', true, 524288, array['image/webp', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Who may put files in a team's folder, or take them out: its captain while signup is open, and an
-- administrator at any time. The same rule the entrant guard applies to the name and the logo column.
-- Definer, because the storage policies run as the caller and the caller may not be able to read a
-- pending team that is not theirs - which is the point, but the question still needs an answer.
create or replace function public.can_edit_team_logo(p_object text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ent uuid;
  tid uuid;
begin
  if public.is_admin() then
    return true;
  end if;
  begin
    ent := split_part(p_object, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  select e.tournament_id into tid
    from tournament_entrants e
   where e.id = ent
     and e.captain_user_id = auth.uid()
     and e.status in ('pending', 'approved');
  return tid is not null and public.tournament_signup_open(tid);
end;
$$;

grant execute on function public.can_edit_team_logo(text) to authenticated;

-- Reading needs no policy: a public bucket serves its files to anyone by address. The select policy
-- below is what lets the storage API find a file in order to delete or replace it, so it follows the
-- same rule as writing.
drop policy if exists "team logos insert" on storage.objects;
create policy "team logos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'team-logos' and public.can_edit_team_logo(name));

drop policy if exists "team logos select" on storage.objects;
create policy "team logos select" on storage.objects for select to authenticated
  using (bucket_id = 'team-logos' and public.can_edit_team_logo(name));

drop policy if exists "team logos delete" on storage.objects;
create policy "team logos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'team-logos' and public.can_edit_team_logo(name));

-- ===========================================================================
--  The entrant guard, extended
-- ===========================================================================
-- Reproduced in full (create or replace cannot patch a body). The one change: the logo follows the
-- name - a captain may set or clear it while signup is open, and after that it is an administrator's.
create or replace function public.guard_tournament_entrant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  taken int;
begin
  if public.is_service_session() or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.forfeited_at is not null then
      raise exception 'Only an administrator can change that';
    end if;

    select t.max_entrants into cap from tournaments t where t.id = new.tournament_id;
    select count(*) into taken from tournament_entrants e
     where e.tournament_id = new.tournament_id and e.status in ('pending', 'approved');
    if cap is not null and taken >= cap then
      raise exception 'This event is full';
    end if;

    if exists (
      select 1
        from tournament_roster r
        join tournament_entrants e on e.id = r.entrant_id
       where r.user_id = new.captain_user_id
         and e.tournament_id = new.tournament_id
         and e.status in ('pending', 'approved')
    ) then
      raise exception 'You are already on a team in this event';
    end if;
    return new;
  end if;

  -- UPDATE, by a captain. They may rename the team or change its logo while signup is open, or withdraw it.
  if new.tournament_id is distinct from old.tournament_id
     or new.captain_user_id is distinct from old.captain_user_id
     or new.seed is distinct from old.seed
     or new.forfeited_at is distinct from old.forfeited_at then
    raise exception 'Only an administrator can change that';
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'withdrawn' then
      raise exception 'Only an administrator can approve or reject a team';
    end if;
    -- Once the event is running the team is in the bracket, and pulling it out is a decision about
    -- everyone it is scheduled to play - an administrator's, not the captain's.
    if not public.tournament_signup_open(old.tournament_id) then
      raise exception 'Signup has closed - ask an administrator to withdraw the team';
    end if;
    return new;
  end if;

  if new.name is distinct from old.name and not public.tournament_signup_open(old.tournament_id) then
    raise exception 'Signup has closed - ask an administrator to change the team name';
  end if;
  if new.logo_path is distinct from old.logo_path and not public.tournament_signup_open(old.tournament_id) then
    raise exception 'Signup has closed - ask an administrator to change the team logo';
  end if;
  return new;
end;
$$;
