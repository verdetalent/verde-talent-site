-- Sectors and markets an account follows on their own, without picking roles.
--
-- intel_watchlist holds role-and-market pairs, which is what the dashboard is built on. A
-- company with no postings may not know which roles to name yet, but knows it is a storage
-- company hiring in Texas; the market report and Your markets are built around that. Roles
-- followed later still count towards sectors and markets on top of these.
--
-- Run after 001. Safe to re-run.

create table if not exists public.intel_follows (
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('sector', 'market')),
  key        text not null,             -- a sector (Solar, Wind, Storage, Grid) or a state
  created_at timestamptz not null default now(),
  primary key (user_id, kind, key)
);

alter table public.intel_follows enable row level security;

drop policy if exists "own follows" on public.intel_follows;
create policy "own follows" on public.intel_follows
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.intel_follows to authenticated;
revoke all on public.intel_follows from anon;
