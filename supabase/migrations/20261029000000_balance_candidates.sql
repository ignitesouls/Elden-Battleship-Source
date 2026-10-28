-- The fairest of several passing layouts, collected across calls.
--
-- balance-board used to play the first layout that passed all three fairness tests. Passing is a
-- floor, and the first passer is often a board right on the line, so it now collects BEST_OF passers
-- and plays the fairest (see BEST_OF in src/lib/boardBalance.ts). That is about ten times the draws,
-- which no longer fits inside one call's CPU allowance on most boards, so the search is spread over
-- several calls - some of them at the same time - and this table is where they meet.
--
-- One row per room, holding the fairest passer any call has found for the deal being balanced and
-- how many passers have been seen in all. Never readable by players: these are boards that have not
-- been dealt yet, and a crew that could read the candidates could read the board before the reveal.
-- Only balance-board writes it, through merge_balance_candidate, as the service role.
--
-- `deal_key` names the deal a row belongs to - seed, deal time, set, size and every fleet - so a
-- row left over from a previous match, or from a call that lost the race to write the board, is
-- simply started over the next time the room is balanced. Nothing has to clear it by hand, and rooms
-- going away take their row with them.

create table if not exists public.balance_candidates (
  room_id    uuid primary key references public.rooms(id) on delete cascade,
  deal_key   text not null,
  -- The fairest passing layout seen so far, its score (lower is fairer) and the balance record that
  -- goes onto the room with it. Null until something passes.
  perm       jsonb,
  score      double precision,
  report     jsonb,
  passers    int not null default 0,
  attempts   int not null default 0,
  calls      int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.balance_candidates enable row level security;
revoke all on public.balance_candidates from anon, authenticated;

comment on table public.balance_candidates is
  'Passing board layouts balance-board has found for a deal, pooled across calls. Service role only. See 20261029000000_balance_candidates.sql.';

-- Adds one call's findings to the room's pool and returns the pool as it now stands.
--
-- One statement, so two calls finishing at the same moment cannot both read "nine passers" and both
-- miss the tenth: the row lock orders them, and each sees the other's count.
create or replace function public.merge_balance_candidate(
  p_room     uuid,
  p_key      text,
  p_perm     jsonb,
  p_score    double precision,
  p_report   jsonb,
  p_passers  int,
  p_attempts int
)
returns public.balance_candidates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.balance_candidates;
begin
  -- A call that found no passer brings its draw count and nothing else.
  if p_passers <= 0 then
    p_perm := null;
    p_score := null;
    p_report := null;
  end if;

  insert into balance_candidates as bc (room_id, deal_key, perm, score, report, passers, attempts, calls)
  values (p_room, p_key, p_perm, p_score, p_report, greatest(p_passers, 0), p_attempts, 1)
  on conflict (room_id) do update set
    deal_key = excluded.deal_key,
    perm = case
      when bc.deal_key <> excluded.deal_key then excluded.perm
      when excluded.perm is not null and (bc.perm is null or excluded.score < bc.score) then excluded.perm
      else bc.perm end,
    report = case
      when bc.deal_key <> excluded.deal_key then excluded.report
      when excluded.perm is not null and (bc.perm is null or excluded.score < bc.score) then excluded.report
      else bc.report end,
    score = case
      when bc.deal_key <> excluded.deal_key then excluded.score
      when excluded.perm is not null and (bc.perm is null or excluded.score < bc.score) then excluded.score
      else bc.score end,
    passers  = case when bc.deal_key <> excluded.deal_key then excluded.passers  else bc.passers  + excluded.passers  end,
    attempts = case when bc.deal_key <> excluded.deal_key then excluded.attempts else bc.attempts + excluded.attempts end,
    calls    = case when bc.deal_key <> excluded.deal_key then 1                 else bc.calls    + 1                 end,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.merge_balance_candidate(uuid, text, jsonb, double precision, jsonb, int, int) from public, anon, authenticated;
grant execute on function public.merge_balance_candidate(uuid, text, jsonb, double precision, jsonb, int, int) to service_role;
