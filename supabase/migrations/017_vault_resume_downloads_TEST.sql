-- Test for 017_vault_resume_downloads.sql. Adds five fake candidates with fake resume paths (first
-- name ZZTest, emails at example.invalid), checks whose resume each kind of viewer could download,
-- deletes the fakes again, then shows the results. Runs as one transaction in the SQL editor, so if
-- any step errors nothing is kept. Every row should say PASS.

insert into candidates (first_name, last_name, email, current_employer, hide_from_current_employer,
                        visibility_searchable, visibility_recruiters, experience, resume_path, resume_filename)
values
  ('ZZTest', 'HideNextEra',   'zz1@example.invalid', 'NextEra Energy Resources, LLC', true,  true,  true,  '[]', 'zztest/1.pdf', 'One.pdf'),
  ('ZZTest', 'ShowNextEra',   'zz2@example.invalid', 'NextEra Energy Resources, LLC', false, true,  true,  '[]', 'zztest/2.pdf', 'Two.pdf'),
  ('ZZTest', 'HidePresent',   'zz3@example.invalid', null,                            true,  true,  true,
   '[{"title":"Engineer","co":"Sunrun Inc.","dates":"Jan 2022 - Present"}]',                           'zztest/3.pdf', 'Three.pdf'),
  ('ZZTest', 'NotSearchable', 'zz4@example.invalid', 'Acme',                          false, false, true,  '[]', 'zztest/4.pdf', 'Four.pdf'),
  ('ZZTest', 'NoRecruiters',  'zz5@example.invalid', 'Acme',                          false, true,  false, '[]', 'zztest/5.pdf', 'Five.pdf'),
  ('ZZTest', 'NoResume',      'zz6@example.invalid', 'Acme',                          false, true,  true,  '[]', null,           null);

create temp table zz_ids as select last_name, id from candidates where first_name = 'ZZTest' and email like '%@example.invalid';

-- A signed-in account with no Vault access asks for a resume (as the site would).
create temp table zz_noaccess (n int);
grant all on zz_noaccess to authenticated;
grant select on zz_ids to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000abcd","role":"authenticated"}', true);
insert into zz_noaccess select count(*) from zz_ids i, lateral vault_resume(i.id) r;
reset role;

create temp table zz_results as
with got as (
  select v.viewer, i.last_name, r.resume_path
  from (values ('NextEra Energy', false, 'nextera'), ('SUNRUN', false, 'sunrun'), ('Tesla, Inc.', false, 'tesla'),
               ('Lotus Scout', true, 'agency'), ('Energy Inc', false, 'blank')) v(company, agency, viewer)
  cross join zz_ids i
  cross join lateral vault_resume_for(v.company, v.agency, i.id) r
),
checks(test, ok) as (values
  ('NextEra cannot download the NextEra employee who chose to hide', not exists (select 1 from got where viewer='nextera' and last_name='HideNextEra')),
  ('NextEra can download the NextEra employee who did not hide',     exists     (select 1 from got where viewer='nextera' and last_name='ShowNextEra' and resume_path='zztest/2.pdf')),
  ('Sunrun cannot download someone whose "Present" job is Sunrun',   not exists (select 1 from got where viewer='sunrun'  and last_name='HidePresent')),
  ('Tesla can download that same person',                            exists     (select 1 from got where viewer='tesla'   and last_name='HidePresent')),
  ('Nobody can download a profile with searchable off',              not exists (select 1 from got where last_name='NotSearchable')),
  ('An agency cannot download someone not open to recruiters',       not exists (select 1 from got where viewer='agency'  and last_name='NoRecruiters')),
  ('A direct employer can download someone not open to recruiters',  exists     (select 1 from got where viewer='tesla'   and last_name='NoRecruiters')),
  ('No resume on file means nothing to download',                    not exists (select 1 from got where last_name='NoResume')),
  ('A company name that reduces to nothing downloads nothing',       not exists (select 1 from got where viewer='blank')),
  ('A signed-in account without Vault access gets nothing',          (select n from zz_noaccess) = 0),
  ('A signed-out visitor cannot call the download function',         not has_function_privilege('anon', 'public.vault_resume(uuid)', 'execute')),
  ('Nobody signed in can call the rules function directly',          not has_function_privilege('authenticated', 'public.vault_resume_for(text, boolean, uuid)', 'execute')),
  ('The download log cannot be read from the site',                  not has_table_privilege('authenticated', 'public.vault_resume_downloads', 'select')
                                                                     and not has_table_privilege('anon', 'public.vault_resume_downloads', 'select'))
)
select case when ok then 'PASS' else 'FAIL' end as result, test from checks;

delete from candidates where first_name = 'ZZTest' and email like '%@example.invalid';

select r.*, (select count(*) from candidates where first_name = 'ZZTest') as fakes_left
from zz_results r;
