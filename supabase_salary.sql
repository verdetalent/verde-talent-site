-- Optional employer-entered salary range, either hourly or annual.
alter table job_postings
  add column salary_min integer,
  add column salary_max integer,
  add column salary_period text check (salary_period in ('hour', 'year'));

-- Rebuild the public view to also expose the new salary columns (adding
-- columns to the end of a view's SELECT list is safe with CREATE OR
-- REPLACE - it doesn't disturb the existing column positions/types).
create or replace view public_job_postings as
select
  id, company_name, job_title, job_description, location, sector,
  employment_type, apply_url, company_email, paid_at, expires_at,
  salary_min, salary_max, salary_period
from job_postings
where status = 'paid' and expires_at > now();
