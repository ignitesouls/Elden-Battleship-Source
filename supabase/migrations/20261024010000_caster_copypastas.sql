-- The community's copypastas, for the caster desk to put on stream.
--
-- A caster opens the desk's Copypastas group and sends one over the board, said by a barnacle in a
-- speech bubble like any talking point (see pages/CasterControl and lib/castAux). The list lives here,
-- not in the site's code, so an administrator can add, fix or retire one from the Admin page without a
-- deploy.
--
--   title  what the desk lists it as - a few words, so a long list can be scanned
--   body   what the barnacle says; capped so it still fits a speech bubble over the board
--   mood   which barnacle says it (see BarnacleMood in src/lib/talkingPoints.ts)
--   sort   the order the desk lists them in, lowest first; ties alphabetical by title
--
-- Readable by anyone - the desk can be open in any browser, and nothing here is private. Written only
-- by administrators (is_admin), straight through RLS: there is no rule here beyond who may write.

create table if not exists public.caster_copypastas (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(btrim(title)) between 1 and 60),
  body        text not null check (char_length(btrim(body)) between 1 and 600),
  mood        text not null default 'happy' check (mood in ('happy', 'smug', 'grim', 'angry')),
  sort        int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

alter table public.caster_copypastas enable row level security;

drop policy if exists "copypastas read" on public.caster_copypastas;
create policy "copypastas read" on public.caster_copypastas for select using (true);

drop policy if exists "copypastas insert by admin" on public.caster_copypastas;
create policy "copypastas insert by admin" on public.caster_copypastas for insert with check (public.is_admin());

drop policy if exists "copypastas update by admin" on public.caster_copypastas;
create policy "copypastas update by admin" on public.caster_copypastas for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "copypastas delete by admin" on public.caster_copypastas;
create policy "copypastas delete by admin" on public.caster_copypastas for delete using (public.is_admin());

-- Who last touched a row, and when - stamped here so the admin page cannot get it wrong.
create or replace function public.caster_copypastas_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists caster_copypastas_stamp on public.caster_copypastas;
create trigger caster_copypastas_stamp
  before update on public.caster_copypastas
  for each row execute function public.caster_copypastas_stamp();

grant select on public.caster_copypastas to anon, authenticated;
grant insert, update, delete on public.caster_copypastas to authenticated;

-- The starting list, from the community's Discord, word for word (typos are part of a copypasta). Only
-- into an empty table, so running this again never doubles the list or brings back one an administrator
-- retired. <Team 1> and <Team 2> are filled with tonight's team names by the desk when one is shown.
insert into public.caster_copypastas (title, body, mood, sort)
select v.title, v.body, v.mood, v.sort
  from (values
    ('At the peak',
     'I got lost hiking up a mountain, and I saw a shepherd. I asked him "How far up are we?" and he answered "This Match" That''s how I realized, I already knew the answer. We were at the peak.',
     'smug', 10),
    ('Shura is patient',
     'Shura is patient. You can tell the game has humbled him every step of the way.',
     'smug', 20),
    ('STOP with the copypastas',
     'STOP with the copypastas, it was funny when there were, maybe, two going around. Now it''s actually inhibiting this community''s ability to have meaningful discussion about the game. So just stop, this series is about ELDEN RING, and the game comes FIRST.',
     'angry', 30),
    ('Bingo Brawlers',
     'i am absolute trash at this game compard to everyone in this league and bingo brawlers...that said, everyone in bingo brawlers will destroy these players.....except strump....that guy is insane',
     'happy', 40),
    ('Invincibility button',
     'LMFAO 😂 HOW ARE YOU DYING 🤔 JUST USE YOUR INVINCIBILITY BUTTON 😴',
     'smug', 50),
    ('Both teams want it',
     'so if I understand you correctly it is better for <Team 1> if they win but <Team 2> would also be in a better spot if they win. A very unusual game in which one team would like to win but the other also wants it',
     'happy', 60),
    ('PCR quadrant fight',
     'PCR is my favourite quadrant fight',
     'happy', 70),
    ('Send him to Ignitestan',
     'If you want your son high level battleship, send him Ignitestan 2-3 years and forget',
     'smug', 80),
    ('Playing Sekiro?',
     'is this guy playing sekiro? he died twice',
     'smug', 90),
    ('The RAW EGG',
     'The RAW EGG does not do slashing or bludgeoning damage. It does psychological damage. You see, before you incentivize someone with it, you yell at them "I AM SO SCREWED" and as you drink it in front of them they realize you were right.',
     'grim', 100),
    ('Always jump',
     E'JUMP IS THE FINAL FORM\nALWAYS JUMP',
     'angry', 110),
    ('Wamp, Wamp',
     'A wise man once said: Wamp, Wamp',
     'grim', 120),
    ('Supreme skills',
     'Chat Ill have you know I got Limgrave Tree Sentinel down to 1/3 health without dying with +4 uchigatana so  they not to be jealous of my supreme skills',
     'smug', 130)
  ) as v(title, body, mood, sort)
 where not exists (select 1 from public.caster_copypastas);
