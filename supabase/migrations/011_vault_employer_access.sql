-- Resume Vault: employer read access, with "hide my profile from my current employer" enforced.
--
-- Nothing here opens the Vault by itself. An employer sees candidates only after a row for their
-- account is added to employer_vault_access (by Adam, in SQL). Until then vault_candidates()
-- returns nothing for everyone.
--
-- Why a function and not an RLS policy on candidates: a policy can only hide whole rows, but the
-- Vault also has to hide fields (salary when the candidate turned it off; internal columns such as
-- current_employer, tokens, resume_path). The function returns only the safe columns.
--
-- Rules, all in vault_candidates_for():
--   * Profile searchable OFF          -> never shown.
--   * Open to recruiters OFF          -> hidden from accounts marked is_agency (third-party recruiters).
--   * Show salary range OFF           -> salary_min/max come back empty.
--   * Hide from current employer ON   -> hidden when the viewer's company matches the candidate's
--     current employer, OR any job on their profile whose dates say "Present". Matching is by
--     employer_name_key() word sets, where either side's words being a subset of the other's counts
--     as a match ("NextEra Energy" vs "NextEra Energy Resources, LLC"). It errs toward hiding.
--   * The viewer's company comes from employer_vault_access.company_name, which Adam sets when
--     granting access - NOT from the account's user_metadata, which the employer can edit
--     themselves and so could rename their way around the rule.
--   * A company name that reduces to nothing (e.g. "Energy Inc") sees nothing.
-- Resume FILES are not covered: storage stays owner/admin-only. Downloading resumes needs an edge
-- function applying these same rules before it is offered to employers.

create table if not exists public.employer_vault_access (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  company_name text not null,
  is_agency    boolean not null default false,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz,
  note         text
);
alter table public.employer_vault_access enable row level security;
revoke all on public.employer_vault_access from anon, authenticated;

-- Either name's words are all contained in the other's.
create or replace function public.employer_names_match(a text, b text)
returns boolean language sql immutable as $$
  select case
    when employer_name_key(a) is null or employer_name_key(b) is null then false
    else string_to_array(employer_name_key(a), ' ') <@ string_to_array(employer_name_key(b), ' ')
      or string_to_array(employer_name_key(b), ' ') <@ string_to_array(employer_name_key(a), ' ')
  end;
$$;

create or replace function public.candidate_hidden_from(c public.candidates, company text)
returns boolean language sql stable as $$
  select coalesce(c.hide_from_current_employer, true) and (
    employer_names_match(c.current_employer, company)
    or exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(c.experience) = 'array'
                                     then c.experience else '[]'::jsonb end) e
      where coalesce(e->>'dates', '') ~* 'present'
        and employer_names_match(e->>'co', company)));
$$;

-- The fields an employer may see. Re-running this file drops and recreates it (and the two
-- functions that return it).
drop function if exists public.vault_candidates();
drop function if exists public.vault_candidates_for(text, boolean);
drop type if exists public.vault_candidate;
create type public.vault_candidate as (
  id uuid, created_at timestamptz, first_name text, last_name text, headline text, location text,
  years_experience text, bio text, sectors text[], skills text[], experience jsonb, education jsonb,
  work_style text[], job_type text, relocation text, salary_min integer, salary_max integer,
  availability text, linkedin_url text, website_url text, github_url text, email text,
  has_resume boolean, work_authorization text, veteran_status text);

-- The rules, for a given viewer. Not callable from the site (see revokes below) - the site calls
-- vault_candidates(), which looks the viewer up first. Kept separate so the rules can be tested.
create or replace function public.vault_candidates_for(viewer_company text, viewer_is_agency boolean)
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
    and not candidate_hidden_from(c, viewer_company)
  order by c.created_at desc;
$$;

-- What the Vault page calls (signed in as an employer). Empty unless the account has live access.
create or replace function public.vault_candidates()
returns setof public.vault_candidate
language sql stable security definer set search_path = public as $$
  select v.* from employer_vault_access a,
       lateral vault_candidates_for(a.company_name, a.is_agency) v
  where a.user_id = auth.uid() and (a.expires_at is null or a.expires_at > now());
$$;

-- Supabase lets anon/authenticated execute new public functions by default. Lock them down:
-- only signed-in accounts may call vault_candidates() (and it checks the access list itself);
-- nobody but the database owner may call the rules function with a company name of their choice.
revoke execute on function public.vault_candidates_for(text, boolean) from public, anon, authenticated;
revoke execute on function public.candidate_hidden_from(public.candidates, text) from public, anon, authenticated;
revoke execute on function public.vault_candidates() from public, anon;
grant execute on function public.vault_candidates() to authenticated;
