-- Job alerts: daily or weekly, saved searches, and followed companies.
--
--   * candidates.alert_frequency - 'weekly' (default, every Monday) or 'daily'. The site refreshes
--     its jobs once a day, so daily is as fast as alerts can usefully go.
--   * candidate_saved_searches - a search from jobs.html (its filters, as JSON) the candidate wants
--     new matches for. Up to 10 per candidate.
--   * candidate_company_follows - companies the candidate follows; any new role they post goes in
--     the next alert. Up to 50 per candidate.
--
-- Both tables belong to a candidate profile (alerts stay tied to full profiles, not email-only
-- signups). A signed-in candidate can read, add and delete only their own rows - the same
-- ownership rule saved_jobs uses. The alerts function reads them with the service role.
-- Re-running this file is safe.

alter table public.candidates
  add column if not exists alert_frequency text not null default 'weekly';
-- The newest job (first_seen) in the site's feed when the candidate's last alert was built, so
-- the next alert sends exactly the jobs added since - see the alerts function.
alter table public.candidates
  add column if not exists last_job_alert_watermark timestamptz;
-- "Pause for 30 days" on the dashboard: no alert emails until this time, then they resume.
alter table public.candidates
  add column if not exists alerts_paused_until timestamptz;
alter table public.candidates drop constraint if exists candidates_alert_frequency_check;
alter table public.candidates
  add constraint candidates_alert_frequency_check check (alert_frequency in ('daily', 'weekly'));

create table if not exists public.candidate_saved_searches (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  label        text not null check (length(label) between 1 and 200),
  criteria     jsonb not null check (jsonb_typeof(criteria) = 'object' and length(criteria::text) <= 4000),
  created_at   timestamptz not null default now(),
  unique (candidate_id, criteria)
);

create table if not exists public.candidate_company_follows (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  company_name text not null check (length(company_name) between 1 and 200),
  company_slug text check (company_slug ~ '^[a-z0-9-]{1,120}$'),
  created_at   timestamptz not null default now(),
  unique (candidate_id, company_name)
);
create index if not exists candidate_company_follows_company_idx
  on public.candidate_company_follows (lower(company_name));

alter table public.candidate_saved_searches  enable row level security;
alter table public.candidate_company_follows enable row level security;

-- Signed-out visitors get nothing; signed-in accounts only what the policies below allow.
revoke all on public.candidate_saved_searches  from anon;
revoke all on public.candidate_company_follows from anon;
revoke all on public.candidate_saved_searches  from authenticated;
revoke all on public.candidate_company_follows from authenticated;
grant select, insert, delete on public.candidate_saved_searches  to authenticated;
grant select, insert, delete on public.candidate_company_follows to authenticated;

drop policy if exists "Candidates manage their own saved searches" on public.candidate_saved_searches;
create policy "Candidates manage their own saved searches"
on public.candidate_saved_searches for all to authenticated
using      (candidate_id in (select id from public.candidates where user_id = auth.uid()))
with check (candidate_id in (select id from public.candidates where user_id = auth.uid()));

drop policy if exists "Candidates manage their own company follows" on public.candidate_company_follows;
create policy "Candidates manage their own company follows"
on public.candidate_company_follows for all to authenticated
using      (candidate_id in (select id from public.candidates where user_id = auth.uid()))
with check (candidate_id in (select id from public.candidates where user_id = auth.uid()));

-- Caps, so one account can't fill the tables.
create or replace function public.enforce_alert_limits() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'candidate_saved_searches'
     and (select count(*) from public.candidate_saved_searches where candidate_id = new.candidate_id) >= 10 then
    raise exception 'You can save up to 10 searches. Delete one in your dashboard to add another.';
  end if;
  if tg_table_name = 'candidate_company_follows'
     and (select count(*) from public.candidate_company_follows where candidate_id = new.candidate_id) >= 50 then
    raise exception 'You can follow up to 50 companies.';
  end if;
  return new;
end;
$$;
revoke execute on function public.enforce_alert_limits() from public, anon, authenticated;

drop trigger if exists saved_searches_limit on public.candidate_saved_searches;
create trigger saved_searches_limit before insert on public.candidate_saved_searches
  for each row execute function public.enforce_alert_limits();
drop trigger if exists company_follows_limit on public.candidate_company_follows;
create trigger company_follows_limit before insert on public.candidate_company_follows
  for each row execute function public.enforce_alert_limits();
