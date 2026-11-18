-- Application tracker (dashboard "Applications" tab). On top of 013:
--   * candidates can add applications they made elsewhere (apply_path = 'manual', with the date
--     they applied), and remove their own rows.
-- Manual entries are the candidate's own notes: they never get a check-in email and don't count
-- as Apply clicks from Verde Talent. Re-running this file is safe.

grant insert (applied_at) on public.candidate_applications to authenticated;
grant delete on public.candidate_applications to authenticated;

drop policy if exists "Candidates remove their own applications" on public.candidate_applications;
create policy "Candidates remove their own applications"
on public.candidate_applications for delete to authenticated
using (candidate_id in (select id from public.candidates where user_id = auth.uid()));

-- A date in the future, or years back, is a typo.
alter table public.candidate_applications drop constraint if exists candidate_applications_applied_at_check;
alter table public.candidate_applications
  add constraint candidate_applications_applied_at_check
  check (applied_at <= now() + interval '1 day' and applied_at >= timestamptz '2024-01-01');
