-- "No Apply clicks? Free 30 more days": every paid posting that reaches its end date without a
-- single click on its Apply button on Verde Talent is extended 30 days, once, automatically
-- (posting-guarantee function, daily).
--
--   * posting_apply_clicks - one row per visitor per posting that pressed Apply on employer-job.html
--     (either button). Written only through log_posting_apply(); nobody can read it except the
--     service role - the counts are internal (Adam, 2026-11-18: too small to show employers).
--   * job_postings.guarantee_extended_at - set when the free extension is given (once per posting).
-- Re-running this file is safe.

alter table public.job_postings add column if not exists guarantee_extended_at timestamptz;

create table if not exists public.posting_apply_clicks (
  id             uuid primary key default gen_random_uuid(),
  job_posting_id uuid not null references public.job_postings(id) on delete cascade,
  visitor        text not null check (length(visitor) between 8 and 64),
  clicked_at     timestamptz not null default now(),
  unique (job_posting_id, visitor)
);
alter table public.posting_apply_clicks enable row level security;
revoke all on public.posting_apply_clicks from anon, authenticated;

-- The only way in: records a click for a live paid posting; the same visitor counts once.
create or replace function public.log_posting_apply(p_posting uuid, p_visitor text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_visitor is null or length(p_visitor) < 8 or length(p_visitor) > 64 then return; end if;
  if not exists (select 1 from public.job_postings
                 where id = p_posting and status = 'paid' and expires_at > now()) then return; end if;
  insert into public.posting_apply_clicks (job_posting_id, visitor)
  values (p_posting, p_visitor) on conflict do nothing;
end $$;
revoke all on function public.log_posting_apply(uuid, text) from public;
grant execute on function public.log_posting_apply(uuid, text) to anon, authenticated;
