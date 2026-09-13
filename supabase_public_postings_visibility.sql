-- Make paid postings visible to site visitors again - without exposing
-- company_email or manage_token.
--
-- Background: on 2026-08-10 (commit 97e04a0b) public_job_postings became
-- `security_invoker = true` to stop it leaking company_email. That runs the
-- view with the visitor's own permissions, and the anon role has no SELECT
-- policy on job_postings - so the view has returned zero rows to every
-- visitor since: paid postings never appeared on jobs.html, and
-- employer-job.html said "no longer available". (Verified 2026-09-13: anon
-- sees 0 of job_postings' rows. No customer posting was affected - the only
-- paid rows were internal tests.)
--
-- Fix, keeping security_invoker:
--   1. anon may read only the public columns of job_postings (never
--      company_email, manage_token, stripe ids, employer_user_id, ...),
--   2. and only live paid rows (RLS policy),
--   3. and the view gains salary + is_international, which jobs.html and
--      employer-job.html already try to read.
-- post-job.html's anon insert uses Prefer: return=minimal, so it needs no
-- SELECT and is unaffected; everything else goes through service-role
-- Edge Functions, which bypass both grants and RLS.
--
-- Supersedes the view definitions in supabase_salary.sql and
-- supabase_international.sql - do NOT re-run those: they recreate the view
-- without security_invoker and with company_email.

begin;

revoke select on job_postings from anon;
grant select (
  id, company_name, job_title, job_description, location, sector,
  employment_type, apply_url, paid_at, expires_at,
  salary_min, salary_max, salary_period, is_international, status
) on job_postings to anon;

drop policy if exists "Public can view live paid postings" on job_postings;
create policy "Public can view live paid postings"
on job_postings
for select
to anon
using (status = 'paid' and expires_at > now());

create or replace view public_job_postings
with (security_invoker = true)
as
select
  id, company_name, job_title, job_description, location, sector,
  employment_type, apply_url, paid_at, expires_at,
  salary_min, salary_max, salary_period, is_international
from job_postings
where status = 'paid' and expires_at > now();

grant select on public_job_postings to anon;

commit;
