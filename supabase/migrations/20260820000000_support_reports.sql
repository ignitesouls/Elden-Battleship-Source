-- Bug reports and support messages, on their way to an inbox.
--
-- -- Why a table at all, when the report is emailed anyway -----------------------------------------
--
-- Two reasons, and neither is archival.
--
-- The first is rate limiting. The support endpoint has to be reachable without a session (see
-- config.toml) because a form that requires working auth cannot receive "I can't sign in", and a
-- public unauthenticated endpoint that sends email on demand is a spam relay unless something
-- counts. Edge functions are stateless and per-invocation, so an in-memory counter resets whenever
-- the runtime feels like it. A row is the only counter that survives.
--
-- The second is that email delivery is the part most likely to break. If the sending key expires or
-- the provider drops a message, the report still exists here and can be read out of the dashboard.
-- Losing somebody's bug report because a third party had an outage is the one failure this whole
-- feature exists to prevent.
--
-- -- What is deliberately NOT stored ---------------------------------------------------------------
--
-- The reporter's email address, because the form never asks for one. Contact is a Discord handle,
-- which is a public name rather than a credential and is worth exactly as much to a leak as reading
-- it off the server it names.
--
-- The screenshot. It is attached to the email and thrown away. Storing player-submitted images
-- means a bucket, a retention policy and a moderation question, all to keep a copy of something
-- already sitting in an inbox.

create table if not exists public.support_reports (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  -- Null for a signed-out reporter. Not a foreign key on purpose: a report about account trouble
  -- must survive the account, and cascading a bug report out of existence when a user row goes
  -- away deletes exactly the evidence somebody wanted.
  user_id     uuid,

  -- Whatever the reporter typed, plus the account name resolved server-side. Both are free text
  -- and neither is trusted.
  discord     text,
  reporter    text,

  category    text not null,
  message     text not null,

  -- Browser, screen, build id, and the page they came from. Rendered into the email and kept here
  -- so a "works for me" can be checked against what they were actually running.
  context     jsonb,

  has_screenshot boolean not null default false,

  -- SHA-256 of the caller's IP with a server-side pepper. The rate limiter needs to recognise a
  -- repeat caller; it does not need to know who they are, and an IP address in a table is a
  -- liability that a hash of one is not.
  ip_hash     text,

  -- Whether the provider accepted it. False means the row is the only copy.
  emailed     boolean not null default false
);

-- The rate limiter's only query: how many from this hash since a cutoff.
create index if not exists support_reports_ip_recent
  on public.support_reports (ip_hash, created_at desc);

alter table public.support_reports enable row level security;

-- No policies whatsoever, which is the point. RLS with no policy denies everything to `anon` and
-- `authenticated` alike, so the table is unreadable and unwritable from any browser. The support
-- function reaches it with the service role key, which bypasses RLS. Nobody can read other
-- people's reports, and nobody can forge one without going through the endpoint's checks.

comment on table public.support_reports is
  'Support and bug reports. Written only by the support edge function via the service role key; no browser can read or write it. Doubles as the rate limiter for that endpoint.';
