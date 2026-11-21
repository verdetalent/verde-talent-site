-- "Did you finish applying?" (2026-11-21). An Apply click on a job that takes applications on
-- the employer's own site no longer counts as an application: it starts as 'started', and the
-- candidate confirms it ('applied') or drops it ('not_applied') with one tap - on the page when
-- they come back from the employer's site, or later in their dashboard tracker. Applications
-- sent through Verde Talent itself, and jobs candidates add to their tracker by hand, are
-- applications already and start as 'applied'.
--
-- The status is set here, not by the browser: candidates can't insert a status at all (013
-- grants insert on the job fields only), so nobody can mark a click "applied" by editing a request.
-- Existing rows are left as they are.

alter table public.candidate_applications drop constraint if exists candidate_applications_status_check;
alter table public.candidate_applications add constraint candidate_applications_status_check
  check (status in ('started', 'applied', 'interviewing', 'hired', 'no_luck', 'not_applied'));
alter table public.candidate_applications alter column status set default 'started';

create or replace function public.candidate_applications_initial_status()
returns trigger language plpgsql as $$
begin
  new.status := case when new.apply_path in ('verde_profile', 'manual') then 'applied' else 'started' end;
  return new;
end $$;

drop trigger if exists candidate_applications_initial_status on public.candidate_applications;
create trigger candidate_applications_initial_status before insert on public.candidate_applications
  for each row execute function public.candidate_applications_initial_status();
