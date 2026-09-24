-- Per-employer watchlist: the roles and markets this account cares about.
--
-- Intelligence is sold as a standalone product, not bundled with job postings, so a
-- paying account may have nothing in job_postings at all. The dashboard's whole spine -
-- your roles, benchmarked - has nothing to stand on for those buyers, and an empty page
-- on day one is how a subscription gets cancelled in week one. This table is what the
-- setup flow writes so the dashboard has something to show immediately.
--
-- Unlike the intel_* data tables, rows here belong to the user who created them, so the
-- policies are ownership-based rather than entitlement-based. Both still apply: without
-- an active subscription the data tables return nothing, so a watchlist of markets they
-- cannot read is harmless.
--
-- Run in the Supabase SQL editor, after 001_intelligence_pro.sql. Safe to re-run.

create table if not exists public.intel_watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null,
  scope      text not null default 'state' check (scope in ('national', 'state', 'metro')),
  area_key   text not null,                 -- 'US', a state abbreviation, or a CBSA code
  source     text not null default 'manual' check (source in ('manual', 'posting', 'setup')),
  created_at timestamptz not null default now(),
  unique (user_id, role, scope, area_key)
);

comment on table public.intel_watchlist is
  'Roles and markets an account follows. Seeded by the setup flow for accounts with no
   job postings, and automatically from job_postings for accounts that have them -
   `source` records which, so a seeded row can be replaced later without discarding
   anything the employer chose by hand.';

create index if not exists intel_watchlist_user_idx on public.intel_watchlist (user_id);

alter table public.intel_watchlist enable row level security;

-- Ownership, not entitlement: an employer manages their own rows and never sees anyone
-- else's. A single policy covers all four verbs, so there is one rule to reason about
-- rather than four that could drift apart.
drop policy if exists "own watchlist" on public.intel_watchlist;
create policy "own watchlist" on public.intel_watchlist
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.intel_watchlist to authenticated;
revoke all on public.intel_watchlist from anon;
