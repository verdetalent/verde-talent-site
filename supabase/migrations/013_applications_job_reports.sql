-- Candidate-side proof: which jobs a candidate clicked Apply on, and whether they found a job.
--
--   * candidate_applications - one row per job a signed-in candidate clicked Apply on (job pages,
--     paid postings, and the "Continue to your application" button after sign-up/sign-in).
--     status is the candidate's own answer to "Any news?": applied (no answer yet),
--     interviewing, hired, no_luck or not_applied. Shown back to them on the dashboard and asked
--     about once by email about three weeks later (job-checkins function).
--   * candidate_job_reports - every answer to "Did you find a new job?", yes or no, so the site
--     can say "x% of candidates who told us found a job". For a yes it also records whether they
--     found it through Verde Talent (yes / partly / no), the role and company, an optional quote,
--     and how they agreed to it being shared (first name only is the default).
--     review_status is set by the site owner only: nothing is shown anywhere until it is
--     'approved'.
--   * candidates.checkin_emails - "Stop these check-in emails" in the check-in email turns it off.
--   * candidates.last_checkin_email_at - at most one check-in email a month.
--
-- A signed-in candidate can read and add only their own rows, and change only an application's
-- status. Employers never see any of it. The admin account (contact@verdetalent.com) reads
-- everything and approves or declines reports. Re-running this file is safe.

alter table public.candidates add column if not exists checkin_emails boolean not null default true;
alter table public.candidates add column if not exists last_checkin_email_at timestamptz;

create table if not exists public.candidate_applications (
  id              uuid primary key default gen_random_uuid(),
  candidate_id    uuid not null references public.candidates(id) on delete cascade,
  -- The employer's apply URL, or "posting:<id>" for a paid posting that takes applications on
  -- Verde Talent. One row per job per candidate; clicking Apply again changes nothing.
  job_key         text not null check (length(job_key) between 1 and 2000),
  job_title       text check (length(job_title) <= 300),
  company         text check (length(company) <= 200),
  location        text check (length(location) <= 200),
  job_url         text check (length(job_url) <= 2000),
  job_page        text check (length(job_page) <= 300),   -- e.g. /jobs/<slug>.html
  apply_path      text check (length(apply_path) <= 40),  -- signed_in, after_signup, ...
  applied_at      timestamptz not null default now(),
  status          text not null default 'applied'
                  check (status in ('applied', 'interviewing', 'hired', 'no_luck', 'not_applied')),
  status_at       timestamptz,
  checkin_sent_at timestamptz,
  -- When an answer last came in from the check-in email (spots link-scanning bots that "click"
  -- every button within seconds).
  answered_by_email_at timestamptz,
  unique (candidate_id, job_key)
);
create index if not exists candidate_applications_checkin_idx
  on public.candidate_applications (applied_at) where status = 'applied' and checkin_sent_at is null;

create table if not exists public.candidate_job_reports (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references public.candidates(id) on delete cascade,
  application_id uuid references public.candidate_applications(id) on delete set null,
  found_job      boolean not null,
  via_verde      text check (via_verde in ('yes', 'partly', 'no')),
  job_title      text check (length(job_title) <= 300),
  company        text check (length(company) <= 200),
  quote          text check (length(quote) <= 600),
  share_consent  text not null default 'first_name' check (share_consent in ('first_name', 'anonymous', 'none')),
  asked_from     text not null check (asked_from in ('dashboard_card', 'dashboard_link', 'checkin_email', 'status_change', 'alerts_off')),
  created_at     timestamptz not null default now(),
  review_status  text not null default 'new' check (review_status in ('new', 'approved', 'declined')),
  reviewed_at    timestamptz,
  check (found_job or (via_verde is null and quote is null))
);
create index if not exists candidate_job_reports_candidate_idx on public.candidate_job_reports (candidate_id, created_at desc);

alter table public.candidate_applications enable row level security;
alter table public.candidate_job_reports  enable row level security;

revoke all on public.candidate_applications from anon, authenticated;
revoke all on public.candidate_job_reports  from anon, authenticated;
grant select on public.candidate_applications to authenticated;
grant insert (candidate_id, job_key, job_title, company, location, job_url, job_page, apply_path)
  on public.candidate_applications to authenticated;
grant update (status, status_at) on public.candidate_applications to authenticated;
grant select on public.candidate_job_reports to authenticated;
-- review_status / reviewed_at are left out: a candidate can't approve their own story.
grant insert (candidate_id, application_id, found_job, via_verde, job_title, company, quote, share_consent, asked_from)
  on public.candidate_job_reports to authenticated;
grant update (review_status, reviewed_at) on public.candidate_job_reports to authenticated;

drop policy if exists "Candidates read their own applications" on public.candidate_applications;
create policy "Candidates read their own applications"
on public.candidate_applications for select to authenticated
using (candidate_id in (select id from public.candidates where user_id = auth.uid())
       or auth.jwt() ->> 'email' = 'contact@verdetalent.com');

drop policy if exists "Candidates add their own applications" on public.candidate_applications;
create policy "Candidates add their own applications"
on public.candidate_applications for insert to authenticated
with check (candidate_id in (select id from public.candidates where user_id = auth.uid()));

drop policy if exists "Candidates update their own application status" on public.candidate_applications;
create policy "Candidates update their own application status"
on public.candidate_applications for update to authenticated
using      (candidate_id in (select id from public.candidates where user_id = auth.uid()))
with check (candidate_id in (select id from public.candidates where user_id = auth.uid()));

drop policy if exists "Candidates read their own job reports" on public.candidate_job_reports;
create policy "Candidates read their own job reports"
on public.candidate_job_reports for select to authenticated
using (candidate_id in (select id from public.candidates where user_id = auth.uid())
       or auth.jwt() ->> 'email' = 'contact@verdetalent.com');

drop policy if exists "Candidates add their own job reports" on public.candidate_job_reports;
create policy "Candidates add their own job reports"
on public.candidate_job_reports for insert to authenticated
with check (candidate_id in (select id from public.candidates where user_id = auth.uid())
            and (application_id is null or application_id in (
              select a.id from public.candidate_applications a
              join public.candidates c on c.id = a.candidate_id where c.user_id = auth.uid())));

drop policy if exists "Admin reviews job reports" on public.candidate_job_reports;
create policy "Admin reviews job reports"
on public.candidate_job_reports for update to authenticated
using      (auth.jwt() ->> 'email' = 'contact@verdetalent.com')
with check (auth.jwt() ->> 'email' = 'contact@verdetalent.com');

-- At most 500 applications per candidate and 20 reports a day, so a script can't flood the tables.
create or replace function public.enforce_application_limits() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'candidate_applications' then
    if (select count(*) from public.candidate_applications where candidate_id = new.candidate_id) >= 500 then
      raise exception 'You can track up to 500 applications.';
    end if;
  else
    if (select count(*) from public.candidate_job_reports
        where candidate_id = new.candidate_id and created_at > now() - interval '1 day') >= 20 then
      raise exception 'Too many answers today - please try again tomorrow.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists candidate_applications_limit on public.candidate_applications;
create trigger candidate_applications_limit before insert on public.candidate_applications
  for each row execute function public.enforce_application_limits();
drop trigger if exists candidate_job_reports_limit on public.candidate_job_reports;
create trigger candidate_job_reports_limit before insert on public.candidate_job_reports
  for each row execute function public.enforce_application_limits();
