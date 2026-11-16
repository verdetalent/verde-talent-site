-- Test for 011_vault_employer_access.sql. Adds five fake candidates (first name ZZTest, emails at
-- example.invalid), checks what different viewers would see, deletes the fakes again, then shows the
-- results. The editor runs the script as one transaction, so if any step errors nothing is kept.
-- Every row should say PASS.

insert into candidates (first_name, last_name, email, current_employer, hide_from_current_employer,
                        visibility_searchable, visibility_recruiters, visibility_salary,
                        salary_min, salary_max, experience)
values
  ('ZZTest', 'HideNextEra',   'zz1@example.invalid', 'NextEra Energy Resources, LLC', true,  true,  true,  true,  90000, 120000, '[]'),
  ('ZZTest', 'ShowNextEra',   'zz2@example.invalid', 'NextEra Energy Resources, LLC', false, true,  true,  false, 90000, 120000, '[]'),
  ('ZZTest', 'HidePresent',   'zz3@example.invalid', null,                            true,  true,  true,  true,  null,  null,
   '[{"title":"Engineer","co":"Sunrun Inc.","dates":"Jan 2022 - Present"},{"title":"Intern","co":"Tesla","dates":"2020 - 2021"}]'),
  ('ZZTest', 'NotSearchable', 'zz4@example.invalid', 'Acme',                          false, false, true,  true,  null,  null, '[]'),
  ('ZZTest', 'NoRecruiters',  'zz5@example.invalid', 'Acme',                          false, true,  false, true,  null,  null, '[]');

create temp table zz_vault_results as
with seen as (
  select 'nextera'  as viewer, last_name, salary_min from vault_candidates_for('NextEra Energy', false) where first_name = 'ZZTest'
  union all select 'sunrun', last_name, salary_min from vault_candidates_for('SUNRUN', false) where first_name = 'ZZTest'
  union all select 'tesla',  last_name, salary_min from vault_candidates_for('Tesla, Inc.', false) where first_name = 'ZZTest'
  union all select 'agency', last_name, salary_min from vault_candidates_for('Lotus Scout', true) where first_name = 'ZZTest'
  union all select 'blank',  last_name, salary_min from vault_candidates_for('Energy Inc', false) where first_name = 'ZZTest'
),
checks(test, ok) as (values
  ('NextEra cannot see the NextEra employee who chose to hide',       not exists (select 1 from seen where viewer='nextera' and last_name='HideNextEra')),
  ('NextEra can see the NextEra employee who did not hide',           exists     (select 1 from seen where viewer='nextera' and last_name='ShowNextEra')),
  ('Salary is blank when the candidate turned salary off',            exists     (select 1 from seen where viewer='nextera' and last_name='ShowNextEra' and salary_min is null)),
  ('Salary shows when the candidate left it on',                      exists     (select 1 from seen where viewer='sunrun'  and last_name='HideNextEra' and salary_min = 90000)),
  ('Sunrun cannot see someone whose "Present" job is at Sunrun',      not exists (select 1 from seen where viewer='sunrun'  and last_name='HidePresent')),
  ('A past employer (Tesla) can still see them',                      exists     (select 1 from seen where viewer='tesla'   and last_name='HidePresent')),
  ('Nobody sees a profile with searchable off',                       not exists (select 1 from seen where last_name='NotSearchable')),
  ('An agency cannot see someone not open to recruiters',             not exists (select 1 from seen where viewer='agency'  and last_name='NoRecruiters')),
  ('A direct employer can see someone not open to recruiters',        exists     (select 1 from seen where viewer='tesla'   and last_name='NoRecruiters')),
  ('A company name that reduces to nothing sees nobody',              not exists (select 1 from seen where viewer='blank')),
  ('A signed-out visitor cannot call the rules function',             not has_function_privilege('anon', 'public.vault_candidates_for(text, boolean)', 'execute')),
  ('A signed-in account cannot call the rules function directly',     not has_function_privilege('authenticated', 'public.vault_candidates_for(text, boolean)', 'execute')),
  ('A signed-out visitor cannot call the Vault function',             not has_function_privilege('anon', 'public.vault_candidates()', 'execute')),
  ('Nobody has Vault access yet',                                     (select count(*) from employer_vault_access) = 0)
)
select case when ok then 'PASS' else 'FAIL' end as result, test from checks;

delete from candidates where first_name = 'ZZTest' and email like '%@example.invalid';

select r.*, (select count(*) from candidates where first_name = 'ZZTest') as fakes_left
from zz_vault_results r;
