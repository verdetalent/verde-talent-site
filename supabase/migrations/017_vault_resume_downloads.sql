-- Resume Vault: resume FILE downloads, with the same rules as the candidate list (011).
--
-- An employer can download a candidate's resume only when vault_candidates_for() would show them
-- that candidate: live employer_vault_access row, profile searchable, open to recruiters (for
-- agencies), and NOT hidden from the viewer's company ("hide from current employer"). The resume
-- file itself stays in the private "resumes" bucket - the vault-resume edge function asks
-- vault_resume() for the file's location, and only then signs a link that expires in 60 seconds.
--
--   * vault_resume_for(company, is_agency, candidate) - the rule, for testing. Nobody but the
--     database owner (and the service role) may call it with a company name of their choice.
--   * vault_resume(candidate) - what the edge function calls as the signed-in employer. Looks the
--     viewer up in employer_vault_access by auth.uid(); returns nothing without live access.
--   * vault_resume_downloads - who downloaded whose resume, when. Written by the edge function
--     (service role) only; nobody can read it from the site.
-- Re-running this file is safe.

create or replace function public.vault_resume_for(viewer_company text, viewer_is_agency boolean, p_candidate uuid)
returns table (resume_path text, resume_filename text)
language sql stable security definer set search_path = public as $$
  select c.resume_path, c.resume_filename
  from vault_candidates_for(viewer_company, viewer_is_agency) v
  join candidates c on c.id = v.id
  where v.id = p_candidate and c.resume_path is not null
  limit 1;
$$;

create or replace function public.vault_resume(p_candidate uuid)
returns table (resume_path text, resume_filename text, viewer_company text)
language sql stable security definer set search_path = public as $$
  select r.resume_path, r.resume_filename, a.company_name
  from employer_vault_access a,
       lateral vault_resume_for(a.company_name, a.is_agency, p_candidate) r
  where a.user_id = auth.uid() and (a.expires_at is null or a.expires_at > now())
  limit 1;
$$;

create table if not exists public.vault_resume_downloads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  candidate_id  uuid not null references public.candidates(id) on delete cascade,
  company_name  text,
  downloaded_at timestamptz not null default now()
);
create index if not exists vault_resume_downloads_user_idx on public.vault_resume_downloads (user_id, downloaded_at desc);
alter table public.vault_resume_downloads enable row level security;
revoke all on public.vault_resume_downloads from anon, authenticated;

revoke execute on function public.vault_resume_for(text, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.vault_resume(uuid) from public, anon;
grant execute on function public.vault_resume(uuid) to authenticated;
