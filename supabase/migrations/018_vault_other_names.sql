-- Resume Vault: other names for an employer, for "hide from current employer".
--
-- employer_vault_access.company_name is the one name an employer's account is matched on. A
-- candidate who wrote a different name for the same company ("FPL" for an account set up as
-- "NextEra Energy") would not be hidden by it. other_names holds the extra names Adam adds when
-- granting access; a candidate hiding from their current employer is hidden from the account when
-- ANY of company_name or other_names matches (same word-set matching as before, erring toward
-- hiding). other_names only ever hides more people - it never shows anyone extra.
--
--   update employer_vault_access
--   set other_names = array['FPL', 'Florida Power & Light']
--   where company_name = 'NextEra Energy';
--
-- The rules functions gain a names argument (vault_candidates_for/3, vault_resume_for/4). The old
-- two- and three-argument versions stay as wrappers with no extra names, so 011/017 and their tests
-- keep working. Re-running this file is safe.

alter table public.employer_vault_access add column if not exists other_names text[] not null default '{}';

-- Hidden from the viewer under any of their names.
create or replace function public.candidate_hidden_from_any(c public.candidates, company text, other_names text[])
returns boolean language sql stable as $$
  select candidate_hidden_from(c, company)
      or exists (select 1 from unnest(coalesce(other_names, '{}')) n where candidate_hidden_from(c, n));
$$;

create or replace function public.vault_candidates_for(viewer_company text, viewer_is_agency boolean, viewer_other_names text[])
returns setof public.vault_candidate
language sql stable security definer set search_path = public as $$
  select c.id, c.created_at, c.first_name, c.last_name, c.headline, c.location,
         c.years_experience, c.bio, c.sectors, c.skills, c.experience, c.education,
         c.work_style, c.job_type, c.relocation,
         case when coalesce(c.visibility_salary, true) then c.salary_min end,
         case when coalesce(c.visibility_salary, true) then c.salary_max end,
         c.availability, c.linkedin_url, c.website_url, c.github_url, c.email,
         (c.resume_path is not null or c.resume_filename is not null),
         c.work_authorization, c.veteran_status
  from candidates c
  where employer_name_key(viewer_company) is not null
    and coalesce(c.visibility_searchable, true)
    and not (coalesce(viewer_is_agency, false) and not coalesce(c.visibility_recruiters, true))
    and not candidate_hidden_from_any(c, viewer_company, viewer_other_names)
  order by c.created_at desc;
$$;

-- The 011 two-argument version: no extra names.
create or replace function public.vault_candidates_for(viewer_company text, viewer_is_agency boolean)
returns setof public.vault_candidate
language sql stable security definer set search_path = public as $$
  select * from vault_candidates_for(viewer_company, viewer_is_agency, '{}'::text[]);
$$;

create or replace function public.vault_candidates()
returns setof public.vault_candidate
language sql stable security definer set search_path = public as $$
  select v.* from employer_vault_access a,
       lateral vault_candidates_for(a.company_name, a.is_agency, a.other_names) v
  where a.user_id = auth.uid() and (a.expires_at is null or a.expires_at > now());
$$;

create or replace function public.vault_resume_for(viewer_company text, viewer_is_agency boolean, viewer_other_names text[], p_candidate uuid)
returns table (resume_path text, resume_filename text)
language sql stable security definer set search_path = public as $$
  select c.resume_path, c.resume_filename
  from vault_candidates_for(viewer_company, viewer_is_agency, viewer_other_names) v
  join candidates c on c.id = v.id
  where v.id = p_candidate and c.resume_path is not null
  limit 1;
$$;

-- The 017 three-argument version: no extra names.
create or replace function public.vault_resume_for(viewer_company text, viewer_is_agency boolean, p_candidate uuid)
returns table (resume_path text, resume_filename text)
language sql stable security definer set search_path = public as $$
  select * from vault_resume_for(viewer_company, viewer_is_agency, '{}'::text[], p_candidate);
$$;

create or replace function public.vault_resume(p_candidate uuid)
returns table (resume_path text, resume_filename text, viewer_company text)
language sql stable security definer set search_path = public as $$
  select r.resume_path, r.resume_filename, a.company_name
  from employer_vault_access a,
       lateral vault_resume_for(a.company_name, a.is_agency, a.other_names, p_candidate) r
  where a.user_id = auth.uid() and (a.expires_at is null or a.expires_at > now())
  limit 1;
$$;

revoke execute on function public.candidate_hidden_from_any(public.candidates, text, text[]) from public, anon, authenticated;
revoke execute on function public.vault_candidates_for(text, boolean, text[]) from public, anon, authenticated;
revoke execute on function public.vault_candidates_for(text, boolean) from public, anon, authenticated;
revoke execute on function public.vault_resume_for(text, boolean, text[], uuid) from public, anon, authenticated;
revoke execute on function public.vault_resume_for(text, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.vault_candidates() from public, anon;
grant execute on function public.vault_candidates() to authenticated;
revoke execute on function public.vault_resume(uuid) from public, anon;
grant execute on function public.vault_resume(uuid) to authenticated;
