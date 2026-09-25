-- The Intelligence teaser: tell an employer WHETHER their postings are out of line with the
-- market, without telling them by how much, unless they subscribe.
--
-- "1 of your postings is priced below its market" is the most persuasive thing the site can
-- say to a non-subscriber, because it is about their own job. It is also Pro data: working
-- it out means comparing their pay with a market median they have not paid for. So the
-- comparison is done here, and what leaves the database for a non-subscriber is a count.
--
-- Two pieces:
--
--   intel_posting_benchmark   one row per live posting, written nightly by the service role
--                             (push_intel_to_supabase.py). Holds the market median and the
--                             gap, so it is readable only by the owner AND only with an active
--                             subscription.
--
--   intel_posting_teaser()    callable by any signed-in employer. Takes no arguments - it can
--                             only ever describe the caller's own postings - and returns
--                             counts, never a median, a gap or a posting id.
--
-- Known limit, accepted: an employer could post the same role at different salaries and
-- watch the count flip, to find roughly where the market median sits. Each probe costs a
-- paid posting and a day's wait for the nightly run, which prices it well above the cost of
-- simply subscribing.
--
-- Run after 001 and 002. Safe to re-run.

create table if not exists public.intel_posting_benchmark (
  posting_id         uuid primary key references public.job_postings (id) on delete cascade,
  user_id            uuid not null references auth.users on delete cascade,
  role               text,
  scope              text not null default 'state',
  area_key           text,
  advertised_annual  integer,          -- bottom of the posted range, annualised
  market_median      integer,          -- same basis: bottom of the range, see build_market_intel
  gap_pct            integer,          -- advertised against market, e.g. -14
  below_market       boolean not null default false,
  days_live          integer,
  typical_days       integer,
  slow               boolean not null default false,
  benchmarked        boolean not null default false,  -- false when we could not price it
  updated_at         timestamptz not null default now()
);

comment on table public.intel_posting_benchmark is
  'Each live posting compared with its market. Written only by the service role. Readable
   by the posting''s owner only while they hold Intelligence; everyone else reaches it only
   as counts, through intel_posting_teaser().';

create index if not exists intel_posting_benchmark_user_idx
  on public.intel_posting_benchmark (user_id);

alter table public.intel_posting_benchmark enable row level security;

-- Both conditions, not either: your own rows, and only with an active subscription. A
-- lapsed subscriber loses the numbers immediately and keeps the teaser.
drop policy if exists "owner with intelligence reads" on public.intel_posting_benchmark;
create policy "owner with intelligence reads" on public.intel_posting_benchmark
  for select to authenticated
  using (auth.uid() = user_id and public.has_intel_access());

revoke all on public.intel_posting_benchmark from anon;
grant select on public.intel_posting_benchmark to authenticated;

-- ---------------------------------------------------------------- the teaser -----------
-- Security definer so it can count rows the caller's own policy would hide. That is safe
-- only because of what it returns: four integers about the caller, keyed on auth.uid()
-- inside the function. There is deliberately no parameter to pass someone else's id.
create or replace function public.intel_posting_teaser()
  returns table (
    live_postings integer,   -- the caller's postings that are paid and not expired
    benchmarked   integer,   -- of those, how many we could price against a market
    below_market  integer,   -- of those, how many advertise below it
    slow          integer    -- of those, how many have been up well past the usual time
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  with live as (
    select p.id
      from public.job_postings p
     where p.employer_user_id = auth.uid()
       and p.status = 'paid'
       and p.expires_at > now()
  )
  select
    (select count(*) from live)::integer,
    count(*) filter (where b.benchmarked)::integer,
    count(*) filter (where b.benchmarked and b.below_market)::integer,
    count(*) filter (where b.benchmarked and b.slow)::integer
  from live
  left join public.intel_posting_benchmark b on b.posting_id = live.id;
$$;

comment on function public.intel_posting_teaser is
  'Counts only, for the calling employer: live postings, how many were benchmarked, how many
   sit below their market and how many are slow. Never returns figures or ids.';

revoke all on function public.intel_posting_teaser() from public, anon;
grant execute on function public.intel_posting_teaser() to authenticated;
