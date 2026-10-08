-- Event logos.
--
-- An administrator can give an event a logo when creating it or later from its "Edit details" form. It is
-- shown on the event's front-page banner, at the top of its page, and on its card in the admin list.
--
-- The same arrangement as team logos (20261008000000_team_logos.sql), minus the captains: the image lives
-- in a public bucket under a folder named for the event,
--   event-logos/<tournament id>/<random>.webp
-- and only an administrator may write there. The app shrinks every upload to a 512px square before it is
-- sent, so the size limit here is a backstop, not the real constraint. A new upload always gets a new
-- name, so the files can be cached for good.

-- ===========================================================================
--  The column
-- ===========================================================================
-- The object's path inside the bucket, or null for no logo. The check pins it to the event's own folder.
alter table public.tournaments add column if not exists logo_path text;

alter table public.tournaments drop constraint if exists tournaments_logo_path_check;
alter table public.tournaments add constraint tournaments_logo_path_check
  check (logo_path is null or logo_path ~ ('^' || id::text || '/[A-Za-z0-9-]{8,64}\.(webp|png)$'));

comment on column public.tournaments.logo_path is
  'Path of the event''s logo in the event-logos storage bucket (<tournament id>/<random>.webp), or null.';

-- ===========================================================================
--  The bucket
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-logos', 'event-logos', true, 1048576, array['image/webp', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Reading needs no policy: a public bucket serves its files to anyone by address. The select policy is
-- what lets the storage API find a file in order to delete or replace it - administrators only, like writing.
drop policy if exists "event logos insert" on storage.objects;
create policy "event logos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'event-logos' and public.is_admin());

drop policy if exists "event logos select" on storage.objects;
create policy "event logos select" on storage.objects for select to authenticated
  using (bucket_id = 'event-logos' and public.is_admin());

drop policy if exists "event logos delete" on storage.objects;
create policy "event logos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'event-logos' and public.is_admin());
