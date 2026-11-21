-- Test for 019_applications_started.sql. Adds a fake ZZTest candidate (email at example.invalid)
-- with four Apply records, checks the status each one starts with, deletes the fake again, then
-- shows the results. Every row should say PASS.

insert into candidates (first_name, last_name, email) values ('ZZTest', 'Started', 'zz-started@example.invalid');

insert into candidate_applications (candidate_id, job_key, job_title, apply_path, status)
select id, k, 'ZZ job', p, s from candidates,
  (values ('zz:1', 'signed_in', 'applied'), ('zz:2', 'skipped_profile', null), ('zz:3', 'verde_profile', null), ('zz:4', 'manual', null)) v(k, p, s)
where email = 'zz-started@example.invalid';

create temp table zz_results as
with a as (select job_key, status from candidate_applications
           where candidate_id = (select id from candidates where email = 'zz-started@example.invalid'))
select case when ok then 'PASS' else 'FAIL' end as result, test from (values
  ('An Apply click to an employer''s site starts as Started',          (select status from a where job_key = 'zz:2') = 'started'),
  ('A request that tries to say "applied" still starts as Started',    (select status from a where job_key = 'zz:1') = 'started'),
  ('An application sent through Verde Talent starts as Applied',      (select status from a where job_key = 'zz:3') = 'applied'),
  ('A job added to the tracker by hand starts as Applied',             (select status from a where job_key = 'zz:4') = 'applied'),
  ('Candidates still can''t write the status when adding a row',       not has_column_privilege('authenticated', 'public.candidate_applications', 'status', 'insert')),
  ('Candidates can still update the status (their one-tap answer)',    has_column_privilege('authenticated', 'public.candidate_applications', 'status', 'update'))
) t(test, ok);

delete from candidates where email = 'zz-started@example.invalid';

select r.*, (select count(*) from candidates where email = 'zz-started@example.invalid') as fakes_left from zz_results r;
