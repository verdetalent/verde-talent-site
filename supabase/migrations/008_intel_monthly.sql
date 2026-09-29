-- Monthly insights and the monthly email.
--
--   intel_dataset gains a 'monthly' part: what moved in the last 30 days (competitor moves,
--   pay watch, struggling searches, new and delayed projects, news), built nightly by
--   build_intel_monthly.py and readable by subscribers like the rest of the dataset.
--
--   intel_dataset_history keeps one copy of the dataset per month so the monthly email can
--   say what changed. Service role only: no policy, so no signed-in user can read it.
--
--   intel_subscriptions gains the email opt-out and an unsubscribe token, and subscribers
--   get one function to switch the email on or off for themselves.
--
-- Run after 001-007. Safe to re-run.

alter table public.intel_dataset drop constraint if exists intel_dataset_part_check;
alter table public.intel_dataset add constraint intel_dataset_part_check
  check (part in ('core', 'states', 'metros', 'monthly'));

create table if not exists public.intel_dataset_history (
  month    text not null,              -- 'YYYY-MM'
  part     text not null,
  data     jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (month, part)
);
alter table public.intel_dataset_history enable row level security;
revoke all on public.intel_dataset_history from anon, authenticated;

alter table public.intel_subscriptions
  add column if not exists monthly_email boolean not null default true,
  add column if not exists email_token   uuid    not null default gen_random_uuid();

-- A subscriber can switch the monthly email for their own account, and nothing else: the
-- table has no update policy for users, so this is the only way in.
create or replace function public.set_intel_monthly_email(wanted boolean)
  returns boolean
  language sql
  security definer
  set search_path = public
as $$
  update public.intel_subscriptions
     set monthly_email = wanted, updated_at = now()
   where user_id = auth.uid()
  returning monthly_email;
$$;
revoke all on function public.set_intel_monthly_email(boolean) from public, anon;
grant execute on function public.set_intel_monthly_email(boolean) to authenticated;
