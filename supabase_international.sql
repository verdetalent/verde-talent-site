-- Lets an employer flag a posting as based outside the U.S., so it can be
-- correctly categorized under the site's "International" search scope
-- (which otherwise has no way to know, since employer postings don't go
-- through the crawler's region-detection logic).
alter table job_postings
  add column is_international boolean not null default false;

create or replace view public_job_postings as
select
  id, company_name, job_title, job_description, location, sector,
  employment_type, apply_url, company_email, paid_at, expires_at,
  salary_min, salary_max, salary_period, is_international
from job_postings
where status = 'paid' and expires_at > now();
