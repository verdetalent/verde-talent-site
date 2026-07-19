-- Lets an employer manage (currently: remove) their own posting via a
-- secret link emailed to them once payment succeeds, with no login system
-- needed for employers.
alter table job_postings
  add column manage_token uuid not null default gen_random_uuid();
