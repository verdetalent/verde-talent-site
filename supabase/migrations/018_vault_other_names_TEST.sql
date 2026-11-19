-- Test for 018_vault_other_names.sql. Adds fake ZZTest candidates (emails at example.invalid), checks
-- that an employer's other names hide people from both the list and resume downloads, deletes the
-- fakes again, then shows the results. Every row should say PASS.

insert into candidates (first_name, last_name, email, current_employer, hide_from_current_employer,
                        visibility_searchable, visibility_recruiters, experience, resume_path, resume_filename)
values
  ('ZZTest', 'HideFPL',     'zz1@example.invalid', 'FPL',  true,  true, true, '[]', 'zztest/1.pdf', 'One.pdf'),
  ('ZZTest', 'HideFPLPres', 'zz2@example.invalid', null,   true,  true, true,
   '[{"title":"Lineman","co":"Florida Power & Light","dates":"2021 - Present"}]',  'zztest/2.pdf', 'Two.pdf'),
  ('ZZTest', 'ShowFPL',     'zz3@example.invalid', 'FPL',  false, true, true, '[]', 'zztest/3.pdf', 'Three.pdf'),
  ('ZZTest', 'Elsewhere',   'zz4@example.invalid', 'Duke Energy', true, true, true, '[]', 'zztest/4.pdf', 'Four.pdf');

create temp table zz_ids as select last_name, id from candidates where first_name = 'ZZTest' and email like '%@example.invalid';

create temp table zz_results as
with listed as (
  select 'names' as viewer, last_name from vault_candidates_for('NextEra Energy', false, array['FPL', 'Florida Power & Light']) where first_name = 'ZZTest'
  union all select 'plain', last_name from vault_candidates_for('NextEra Energy', false) where first_name = 'ZZTest'
  union all select 'blankname', last_name from vault_candidates_for('NextEra Energy', false, array['Energy Inc']) where first_name = 'ZZTest'
),
dl as (
  select i.last_name from zz_ids i, lateral vault_resume_for('NextEra Energy', false, array['FPL', 'Florida Power & Light'], i.id) r
),
checks(test, ok) as (values
  ('With other names, an FPL employee hiding is not listed',            not exists (select 1 from listed where viewer='names' and last_name='HideFPL')),
  ('With other names, a "Present" Florida Power & Light job is hidden', not exists (select 1 from listed where viewer='names' and last_name='HideFPLPres')),
  ('With other names, an FPL employee who did not hide is listed',      exists     (select 1 from listed where viewer='names' and last_name='ShowFPL')),
  ('Someone at another company is still listed',                        exists     (select 1 from listed where viewer='names' and last_name='Elsewhere')),
  ('Without other names, the FPL employee would have been listed',      exists     (select 1 from listed where viewer='plain' and last_name='HideFPL')),
  ('An other name that reduces to nothing hides nobody extra',          exists     (select 1 from listed where viewer='blankname' and last_name='HideFPL')),
  ('Their resume cannot be downloaded either',                          not exists (select 1 from dl where last_name in ('HideFPL', 'HideFPLPres'))),
  ('A listed candidate''s resume can be downloaded',                    exists     (select 1 from dl where last_name='ShowFPL')),
  ('Nobody signed in can call the new rules functions',                 not has_function_privilege('authenticated', 'public.vault_candidates_for(text, boolean, text[])', 'execute')
                                                                        and not has_function_privilege('authenticated', 'public.vault_resume_for(text, boolean, text[], uuid)', 'execute')),
  ('A signed-out visitor still cannot call the Vault functions',        not has_function_privilege('anon', 'public.vault_candidates()', 'execute')
                                                                        and not has_function_privilege('anon', 'public.vault_resume(uuid)', 'execute'))
)
select case when ok then 'PASS' else 'FAIL' end as result, test from checks;

delete from candidates where first_name = 'ZZTest' and email like '%@example.invalid';

select r.*, (select count(*) from candidates where first_name = 'ZZTest') as fakes_left
from zz_results r;
