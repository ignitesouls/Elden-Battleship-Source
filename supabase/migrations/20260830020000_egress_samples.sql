-- What one game actually costs in bytes, measured by the clients that spent them.
--
-- -- Why this table has to exist -------------------------------------------------------------------
--
-- Supabase bills egress and reports it per DAY, for the whole project. Nothing it exposes attributes
-- a byte to a match, and the half that matters most here is the half it does not log at all:
--
--   REST/auth/storage   every response is a row in `edge_logs` with a byte count on it, reachable
--                       through the Management API. See the `egress-usage` edge function, which
--                       windows that query to one match and returns the true billed-side number.
--   realtime            websocket frames. No byte counts anywhere in Supabase's logs, at any plan.
--
-- Realtime is the larger half of a live match and always will be: one postgres_changes message per
-- shot fanned out to every player, every spectator, the caster screen and one OBS Browser Source per
-- overlay element. A 141-shot match with eight watchers is thousands of fan-outs, and no server-side
-- record of them exists. The only place that number can be counted is the client that received it.
--
-- So this is the measuring half of a pair, and it is the half nothing else can replace.
--
-- -- What a row is --------------------------------------------------------------------------------
--
-- One browser tab, for one room. `client_id` is minted per tab per room by lib/egressMeter, so a
-- caster who watches two matches in one sitting writes two rows and neither is a running total of
-- the other. The counters are cumulative within a row and the client flushes the same row every
-- 60 seconds, so a tab that is closed hard loses at most a minute rather than everything.
--
-- Deliberately NOT keyed to a user id. Most watchers are anonymous sessions, an OBS Browser Source
-- has no account at all, and the question being asked is "what did this match cost", which is a
-- property of the room and not of who was in it.
--
-- -- Why the counters are not trusted --------------------------------------------------------------
--
-- Anyone can call the RPC below with any numbers in it. That is tolerable because of what these
-- rows are FOR: they inform a capacity decision an admin makes while looking at them, they gate
-- nothing, they are visible to nobody but admins, and they are dropped after thirty days. A forged
-- row costs a wrong number on one admin panel, which is a different class of problem from a forged
-- match record. The clamps and the monotonic rule below exist to bound the damage, not to prevent
-- it - a client that reports honestly is the only kind this can measure.
create table if not exists public.egress_samples (
  -- One tab, one room. The client mints this and reuses it across flushes, so a repeated report
  -- updates the row it already wrote instead of stacking up sixty copies of a growing number.
  client_id uuid primary key,
  /**
   * The room, and deliberately the only identifier here.
   *
   * There is no match_key column, because no client can supply one: the key is `CODE:started_at`
   * and it is minted inside archive_match() when the match is written, so it does not exist while
   * the bytes are being spent and never reaches the browser afterwards. A column for it would be
   * null on every row forever.
   *
   * The admin panel joins these rows to a match on room code and time instead - `first_seen` and
   * `last_seen` bracket the session, and a match in that room that finished inside those bounds is
   * the one being measured. See matchForRoom in components/EgressPanel.
   */
  room_code text,
  -- What this tab was doing, so the panel can say where the bytes went rather than only how many.
  -- An overlay is the interesting one: seven Browser Sources per streamer, each an independent
  -- subscriber paying full freight for the same fan-out.
  role text not null check (role in ('player', 'spectator', 'overlay', 'caster', 'site')),

  -- -- REST ---------------------------------------------------------------------------------------
  -- Compressed bytes, which is what is billed. PostgREST answers chunked and gzipped and sends no
  -- Content-Length at all, so the client re-compresses each body to weigh it - see lib/egressMeter
  -- for the three layers and why the obvious header is not available. `rest_estimated` counts the
  -- responses that could not be compressed and were counted raw, so the panel can say how much of a
  -- total is a measurement and how much is an over-estimate wearing one.
  rest_bytes bigint not null default 0,
  rest_requests integer not null default 0,
  rest_estimated integer not null default 0,

  -- -- Realtime -----------------------------------------------------------------------------------
  -- Frame payload bytes plus a fixed per-frame allowance for the websocket header. Counted off the
  -- socket, so this includes the heartbeats and the presence chatter, not only the shots.
  realtime_bytes bigint not null default 0,
  realtime_messages integer not null default 0,

  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists egress_samples_room_idx on public.egress_samples (room_code);
create index if not exists egress_samples_updated_idx on public.egress_samples (updated_at desc);

alter table public.egress_samples enable row level security;

-- Admins only, and only for reading. There is deliberately no insert or update policy on this table
-- at all: every write goes through the security-definer RPC below, which is the only thing that gets
-- to decide what a legal sample looks like. A client holding the anon key cannot reach the table.
drop policy if exists "egress_samples admin select" on public.egress_samples;
create policy "egress_samples admin select" on public.egress_samples for select
  using (public.is_admin());

/**
 * Records one tab's running byte count.
 *
 * Upsert rather than insert, because the client re-reports the same cumulative counters every minute
 * so that a hard close loses a minute instead of a match.
 *
 * `greatest` on every counter is what makes a re-report safe in the other direction: the values only
 * ever climb within a row, so a flush that arrives out of order - or a client that restarts its
 * counters without minting a new id - cannot walk a match's total backwards. It also means the
 * cheapest forgery, reporting zero, does nothing at all.
 *
 * The caps are per-tab-per-match ceilings, set far above anything a real session produces (a busy
 * caster tab on a two-hour match lands around 20 MB) and low enough that a hostile client cannot
 * make the panel unreadable by claiming a petabyte. Clamped rather than rejected: a sample that
 * bumps the ceiling is still evidence that something is very wrong, and refusing it outright would
 * hide exactly the session worth looking at.
 */
create or replace function public.record_egress_sample(
  p_client_id uuid,
  p_room_code text,
  p_role text,
  p_rest_bytes bigint,
  p_rest_requests integer,
  p_rest_estimated integer,
  p_realtime_bytes bigint,
  p_realtime_messages integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- 2 GB of REST or realtime from one tab is not a session, it is a bug or a forgery. Either way
  -- the number stops climbing here.
  byte_cap constant bigint := 2147483648;
  count_cap constant integer := 5000000;
  fresh boolean;
begin
  if p_client_id is null then
    return;
  end if;
  if p_role is null or p_role not in ('player', 'spectator', 'overlay', 'caster', 'site') then
    return;
  end if;

  select not exists (select 1 from egress_samples s where s.client_id = p_client_id) into fresh;

  insert into egress_samples as e (
    client_id, room_code, role,
    rest_bytes, rest_requests, rest_estimated,
    realtime_bytes, realtime_messages, updated_at
  )
  values (
    p_client_id,
    nullif(left(coalesce(p_room_code, ''), 64), ''),
    p_role,
    least(greatest(coalesce(p_rest_bytes, 0), 0), byte_cap),
    least(greatest(coalesce(p_rest_requests, 0), 0), count_cap),
    least(greatest(coalesce(p_rest_estimated, 0), 0), count_cap),
    least(greatest(coalesce(p_realtime_bytes, 0), 0), byte_cap),
    least(greatest(coalesce(p_realtime_messages, 0), 0), count_cap),
    now()
  )
  on conflict (client_id) do update set
    role = excluded.role,
    rest_bytes = greatest(e.rest_bytes, excluded.rest_bytes),
    rest_requests = greatest(e.rest_requests, excluded.rest_requests),
    rest_estimated = greatest(e.rest_estimated, excluded.rest_estimated),
    realtime_bytes = greatest(e.realtime_bytes, excluded.realtime_bytes),
    realtime_messages = greatest(e.realtime_messages, excluded.realtime_messages),
    updated_at = now();

  -- Swept on the way past, and only when a genuinely new tab appears - roughly once per tab per
  -- match rather than once a minute per tab. These rows answer "what did last night cost", a
  -- question nobody asks about a match from six weeks ago, and letting them accumulate forever
  -- would make the measuring apparatus its own storage line item.
  if fresh then
    delete from egress_samples where updated_at < now() - interval '30 days';
  end if;
end;
$$;

-- Callable by anyone, because the tabs worth measuring are mostly anonymous and an OBS Browser
-- Source has no account at all. It writes only to this table, reads nothing, and returns nothing.
grant execute on function public.record_egress_sample(uuid, text, text, bigint, integer, integer, bigint, integer) to anon, authenticated;

/**
 * One row per room, which is what the admin panel actually reads.
 *
 * `security_invoker` so the admin-only select policy on the table governs this too - a view without
 * it would run as its owner and hand the whole thing to anybody who asked.
 *
 * Grouped by room because the room is the only identifier a client can report - see the note on
 * room_code above. `first_seen` and `last_seen` come out with it so the panel can find the archived
 * match that ran inside those bounds and put a name to the row.
 */
create or replace view public.egress_by_room
with (security_invoker = true) as
select
  s.room_code,
  count(*)::integer as clients,
  (count(*) filter (where s.role = 'player'))::integer as players,
  (count(*) filter (where s.role = 'spectator'))::integer as spectators,
  (count(*) filter (where s.role = 'overlay'))::integer as overlays,
  (count(*) filter (where s.role = 'caster'))::integer as casters,
  sum(s.rest_bytes)::bigint as rest_bytes,
  sum(s.rest_requests)::bigint as rest_requests,
  sum(s.rest_estimated)::bigint as rest_estimated,
  sum(s.realtime_bytes)::bigint as realtime_bytes,
  sum(s.realtime_messages)::bigint as realtime_messages,
  min(s.started_at) as first_seen,
  max(s.updated_at) as last_seen
from public.egress_samples s
group by s.room_code;

comment on view public.egress_by_room is
  'One archived-or-live room per row: what its watchers actually downloaded, split REST vs realtime and counted by what each tab was doing. Admin-only, via the underlying table policy.';

grant select on public.egress_by_room to authenticated;
