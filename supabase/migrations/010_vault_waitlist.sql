-- Resume Vault waitlist: employers who asked to be told when the Vault opens.
-- Written only by the subscribe-vault-waitlist edge function (service role);
-- RLS on with no policies, so the public anon key can neither read nor write it.
create table if not exists public.vault_waitlist (
  id          bigint generated always as identity primary key,
  email       text not null unique,
  first_touch jsonb,
  created_at  timestamptz not null default now(),
  notified_at timestamptz
);

alter table public.vault_waitlist enable row level security;
