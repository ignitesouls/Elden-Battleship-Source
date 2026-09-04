-- One public URL per streamer that always points at the match they are in RIGHT NOW, and shows it
-- from their seat only.
--
-- -- The problem this solves ----------------------------------------------------------------------
--
-- A streamer who wants their audience watching along has exactly one thing to hand them today: a
-- room link with ?spectate=1 on it. It is wrong for that job twice over.
--
-- It goes stale every match, so it cannot live in a Twitch panel or behind a !watch command - the
-- two places an audience actually looks. Same staleness the overlay tokens were built to delete,
-- pointed at viewers instead of at OBS.
--
-- And it hands out the wallhack. Joining as a spectator writes a `players` row with team null, and
-- that row is the key to "fleets select by spectator" and "square_counts select by spectator" - so
-- every viewer who follows that link can read every crew's ship positions, the streamer's opponent
-- included. For a private co-stream that is the feature working as designed. For an audience of
-- strangers it is a room full of people who can see the other side of the board and a chat the
-- streamer now has to moderate for it.
--
-- -- Why there is no new seat, no new column on players, and no policy rewrite ---------------------
--
-- The obvious build is a restricted spectator: join them, mark the row "locked to this crew", and
-- rewrite both spectator policies to respect the mark. That is a guard trigger (a spectator can
-- PATCH their own player row - see guard_player_team), two policy rewrites, and a standing promise
-- that neither is ever weakened by accident. Every one of those is a thing that can be got wrong
-- later, in a place where getting it wrong silently reopens the wallhack.
--
-- So an audience member does not join at all. `rooms`, `players`, `team_ready` and `attacks` are all
-- `select using (true)` already, and `deep_hides` opens on "somebody has fired at that square"
-- rather than on membership - which between them is the entire watch page. The two tables that are
-- NOT public are `fleets` and `square_counts`, and both are gated on the existence of a spectator
-- row. No row, no access. The thing this feature promises is therefore a property of the schema
-- rather than a rule in a component, and it cannot be undone from a devtools console because there
-- is nothing to undo.
--
-- It scales, too, which the seated version does not: a streamer with four hundred viewers would
-- otherwise put four hundred spectator rows in one room's roster.
--
-- -- Why the handle is the Twitch name -------------------------------------------------------------
--
-- This URL is meant to be BROADCAST. It goes in a panel, in a command, in a description - so it is
-- not a credential and there is nothing to keep secret about it, which is the whole reason it can be
-- a name instead of a random string. Twitch logins are unique, lowercase and URL-safe by
-- construction, so /watch/<login> needs no claiming flow, no reserved-word list and no way for one
-- person to squat another's link: you get the name your viewers already type into their address bar.
--
-- The value is already in hand. The twitch-login edge function reads `login` off /helix/users and
-- has always written it into user_metadata; it simply never landed on `profiles`. So this backfills
-- from auth.users and the function starts writing it going forward.
--
-- An anonymous account gets no watch link, and should not: the link is a permanent public identifier
-- and an anonymous session is neither permanent nor identified.

-- --- the handle ----------------------------------------------------------------------------------

alter table public.profiles add column if not exists twitch_login text;

-- Case-insensitive and unique. Twitch hands these out lowercase, so the `lower()` is belt and
-- braces for a row written by hand - but the index has to agree with the lookup in watch_session
-- below, which lowercases what it is given because a viewer typing a URL will not.
--
-- Partial, because most rows have no handle: every anonymous account that has ever played has a
-- profile row with a null here, and a plain unique index would be one entry per null for nothing.
drop index if exists profiles_twitch_login_key;
create unique index profiles_twitch_login_key
  on public.profiles (lower(twitch_login))
  where twitch_login is not null;

-- Everyone who has ever signed in with Twitch, so the feature works on day one rather than after
-- each streamer's next login. auth.users is readable here because migrations run as the owner; the
-- functions below never touch it.
update public.profiles p
   set twitch_login = u.raw_user_meta_data->>'twitch_login'
  from auth.users u
 where u.id = p.id
   and p.twitch_login is null
   and nullif(btrim(u.raw_user_meta_data->>'twitch_login'), '') is not null;

/**
 * The handle is written by the login function and by nobody else.
 *
 * `profiles update own` lets an account write its own row, and PostgREST will happily send any
 * column named in the body - so without this a signed-in user could PATCH `twitch_login` to
 * somebody else's name. On an ordinary column that is a cosmetic problem. On this one it is the
 * whole feature: the handle IS the address of the watch page, so squatting one means serving your
 * own match at another streamer's URL, to their audience.
 *
 * A trigger rather than a policy, for the reason guard_player_team spells out: RLS cannot compare
 * the old row to the new one. USING sees the row as it was and WITH CHECK sees it as it will be,
 * and neither can say "this column did not change".
 *
 * The alternative - revoking the column privilege - would mean revoking table-level UPDATE from
 * `authenticated` first (a table grant implies every column, so a column-level REVOKE against it
 * does nothing) and then re-granting the other five by name. That works right up until somebody adds
 * a sixth column and cannot write it, with an error that says nothing about this decision.
 *
 * Not SECURITY DEFINER, deliberately and for the same reason as the guards it is modelled on: inside
 * a definer function current_user is the owner, so the service-role test below would pass for every
 * caller alive and the guard would wave through exactly what it exists to stop.
 *
 * ⚠ `twitch_id` on this same table is NOT guarded and can still be written by its owner, which is a
 * separate and older hole (lib/profiles.ts upsertProfile sends it from the browser, and the owner
 * grant in the admins migration is keyed on it). Left alone here rather than fixed in passing: it
 * sits on the sign-in path, and a login flow is not a thing to change as a side effect of shipping a
 * watch link.
 */
create or replace function public.guard_twitch_login()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.twitch_login is not distinct from old.twitch_login then
    return new;
  end if;
  if tg_op = 'INSERT' and new.twitch_login is null then
    return new;
  end if;

  -- The login edge function's service key, the SQL editor, and later migrations.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  raise exception 'A watch handle comes from Twitch and cannot be set by hand';
end;
$$;

drop trigger if exists profiles_guard_twitch_login on public.profiles;
create trigger profiles_guard_twitch_login
  before insert or update on public.profiles
  for each row execute function public.guard_twitch_login();

comment on column public.profiles.twitch_login is
  'The account''s Twitch login: unique, lowercase, URL-safe. The address of its owner''s /watch/ page. Written only by the twitch-login edge function - see guard_twitch_login().';


-- --- whether the audience sees the streamer's own hulls -------------------------------------------

/**
 * Off, and it has to default off.
 *
 * The watch page mirrors the "ride along with a crew" spectator view, which is two boards: the
 * enemy waters this crew has been firing into, and their own fleet taking damage. The second board
 * is honest and useful with no hulls on it - every hit, miss and sinking still lands there - so the
 * mirror is not broken by leaving them off, it is only less complete.
 *
 * What turning them on actually costs is worth stating plainly, because it is not obvious from the
 * switch: this URL is public and permanent, so the opponent can open it. A streamer who ticks this
 * is choosing to play with their fleet face-up. That is a legitimate choice - plenty of people
 * stream their board anyway, and the "Your fleet" OBS source has always offered the same trade - but
 * it is theirs to make deliberately, not to inherit from a default.
 */
alter table public.profiles add column if not exists watch_show_fleet boolean not null default false;

comment on column public.profiles.watch_show_fleet is
  'Owner opt-in: may /watch/<handle> draw this player''s ship positions? Default false. Read by watch_handle_fleet(), which returns nothing at all while it is false.';


-- --- watch_session --------------------------------------------------------------------------------
--
-- handle -> which match is this streamer in right now.
--
-- Deliberately the same shape, and the same seat-picking rule, as overlay_session(). The two answer
-- the same question for different audiences - one for a streamer's own OBS, one for their viewers -
-- and if they ever disagreed about which of two seats to report, the stream and the watch page would
-- be showing different matches with no way to tell which was right.
--
-- SECURITY DEFINER is not strictly needed here: every table it reads is world-readable, so an
-- anonymous browser could assemble this from three selects. It is one anyway, for the reasons the
-- overlay one is - a single round trip instead of three from every viewer in a chat that just got
-- linked, and one definition of the seat ordering rather than a copy in the client that drifts.
--
-- -- What it deliberately does NOT return ----------------------------------------------------------
--
-- No fleet (that is the separate call below, and only with consent), no rejoin code, no overlay or
-- ingest token, no email, no Twitch id. A room code, a status, a team, a name to put at the top of
-- the page, and the user id the client needs to watch for the seat changing without polling.
--
-- -- Why a valid handle ALWAYS gets a row ----------------------------------------------------------
--
-- Same reasoning as overlay_session, and it matters more here because the audience is people rather
-- than browser sources. The seat is left-joined, so a streamer who is in no match still answers -
-- with a null room and their user id - which is what lets the page say "they aren't in a match right
-- now" and then pick the match up by itself the moment they join one. A viewer who followed the link
-- five minutes early should not have to refresh.
--
-- An unknown handle gets the empty set, which is the distinction that matters: nothing means "no
-- such streamer", and a row with a null room means "real streamer, not playing".
create or replace function public.watch_session(p_handle text)
returns table (
  room_code    text,
  room_status  text,
  team         int,
  user_id      uuid,
  display_name text,
  show_fleet   boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_handle is null or length(btrim(p_handle)) = 0 then
    return;
  end if;

  return query
  select r.code,
         r.status,
         seat.team,
         pr.id,
         -- Their own choice of name first, their Twitch name second - the same order profileName()
         -- uses everywhere else on the site, so the watch page calls them what the leaderboard does.
         coalesce(pr.nickname, pr.display_name),
         pr.watch_show_fleet
    from profiles pr
    -- One seat, when there is more than one to choose from, by the same ordering overlay_session
    -- uses: the match being played, then the one about to be, then the lobby they are sitting in,
    -- then the one that just ended, most recently joined breaking the tie.
    left join lateral (
      select p.team, p.room_id
        from players p
        join rooms  sr on sr.id = p.room_id
       where p.user_id = pr.id
       order by case sr.status
                  when 'battle'    then 0
                  when 'placement' then 1
                  when 'lobby'     then 2
                  else 3
                end,
                p.joined_at desc
       limit 1
    ) seat on true
    left join rooms r on r.id = seat.room_id
   where pr.twitch_login is not null
     and lower(pr.twitch_login) = lower(btrim(p_handle));
end;
$$;

-- anon as well as authenticated: a viewer following a link out of a Twitch panel has no account here
-- and is never going to be asked for one. That is the point of the feature.
grant execute on function public.watch_session(text) to anon, authenticated;


-- --- watch_handle_fleet ---------------------------------------------------------------------------
--
-- handle -> the ships of the streamer who owns it, and ONLY with their consent.
--
-- The consent is checked here, in the function, rather than in the page that calls it. A page can be
-- read, and its call can be made by hand with the same anonymous key that is already in the JS
-- bundle - so a switch that only reached the client would be a switch that protected nobody. While
-- watch_show_fleet is false this returns the empty set, and there is no argument to pass that
-- changes that.
--
-- Named to avoid colliding with the column: watch_fleet() sitting next to profiles.watch_show_fleet
-- would be two things one word apart that mean different halves of the same feature.
--
-- Same absolute rule as overlay_token_fleet, and the same reason for saying it here: READ ONLY,
-- forever. This must never grow into anything that identifies its caller as the streamer - the
-- caller is a stranger in their audience.
create or replace function public.watch_handle_fleet(p_handle text)
returns table (
  team                int,
  placements          jsonb,
  ship_sunk           jsonb,
  ship_hits_remaining jsonb,
  placement_confirmed boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_handle is null or length(btrim(p_handle)) = 0 then
    return;
  end if;

  return query
  select f.team, f.placements, f.ship_sunk, f.ship_hits_remaining, f.placement_confirmed
    from profiles pr
    join players p on p.user_id = pr.id
    join rooms   r on r.id = p.room_id
    join fleets  f on f.room_id = p.room_id and f.team = p.team
   where pr.twitch_login is not null
     and lower(pr.twitch_login) = lower(btrim(p_handle))
     -- The consent, and the only place it is enforced.
     and pr.watch_show_fleet
     and p.team is not null
   -- The same seat watch_session picked, by the same ordering - otherwise a streamer seated in two
   -- rooms could get one room's board with the other room's ships drawn on it.
   order by case r.status
              when 'battle'    then 0
              when 'placement' then 1
              when 'lobby'     then 2
              else 3
            end,
            p.joined_at desc
   limit 1;
end;
$$;

grant execute on function public.watch_handle_fleet(text) to anon, authenticated;
