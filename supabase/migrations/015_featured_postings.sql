-- "Featured" add-on for paid job postings: $300 for 30 days at the top of the homepage's
-- Featured jobs section (and a Featured badge in the job search). At most 6 featured at once.
--
--   * job_postings.featured_until      - featured while this is in the future (and the posting is live)
--   * job_postings.featured_paid_at    - when the add-on was paid (homepage order: earliest first)
--   * job_postings.featured_session_id - the Stripe Checkout session that paid for it (idempotency)
--   * public_job_postings gains featured_until, so the homepage and job search can show it
--   * featured_slots_left() - how many of the 6 spots are free, for Post a Job and the sellers
--
-- Only the stripe-webhook function (service role) ever sets these. Re-running this file is safe.

alter table public.job_postings add column if not exists featured_until timestamptz;
alter table public.job_postings add column if not exists featured_paid_at timestamptz;
alter table public.job_postings add column if not exists featured_session_id text;

-- Visitors may read the two public featured columns (never the session id), like the others.
grant select (featured_until, featured_paid_at) on public.job_postings to anon;

-- Same view as today (security_invoker, live paid rows only), with featured_until added at the end.
create or replace view public.public_job_postings
with (security_invoker = true)
as
select
  id, company_name, job_title, job_description, location, sector,
  employment_type, apply_url, paid_at, expires_at,
  salary_min, salary_max, salary_period, is_international,
  work_arrangement, visa_sponsorship,
  featured_until
from public.job_postings
where status = 'paid' and expires_at > now();

grant select on public.public_job_postings to anon;

create or replace function public.featured_slots_left() returns integer
language sql stable security definer set search_path = public as $$
  select greatest(0, 6 - count(*)::int)
  from public.job_postings
  where status = 'paid' and expires_at > now() and featured_until > now();
$$;
revoke all on function public.featured_slots_left() from public;
grant execute on function public.featured_slots_left() to anon, authenticated;
