-- Intelligence Pro: entitlement + the data it unlocks.
--
-- The site is static (GitHub Pages), so there is no server to check a subscription before
-- rendering a page. Every request goes from the browser straight to PostgREST with the
-- signed-in employer's JWT, which means row-level security IS the paywall - not the page,
-- not the markup, not a hidden div. The anon key is public in the page source by design;
-- these policies are what actually protects the data.
--
-- Run in the Supabase SQL editor. Safe to re-run.

-- ---------------------------------------------------------------- entitlement ----------
create table if not exists public.intel_subscriptions (
  user_id            uuid primary key references auth.users on delete cascade,
  plan               text not null check (plan in ('pro', 'enterprise')),
  status             text not null default 'active' check (status in ('active', 'past_due', 'canceled')),
  started_at         timestamptz not null default now(),
  current_period_end timestamptz not null,
  note               text,
  updated_at         timestamptz not null default now()
);

comment on table public.intel_subscriptions is
  'One row per employer with Intelligence access. Written only by the service role - grant
   by hand today, by the Stripe webhook later. No client-side insert/update policy exists,
   so a signed-in user cannot grant themselves access.';

alter table public.intel_subscriptions enable row level security;

drop policy if exists "read own subscription" on public.intel_subscriptions;
create policy "read own subscription" on public.intel_subscriptions
  for select to authenticated using (auth.uid() = user_id);

-- Security definer so the check can read the subscriptions table even though the caller's
-- own policy only exposes their row; stable so Postgres evaluates it once per statement.
create or replace function public.has_intel_access()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
      from public.intel_subscriptions s
     where s.user_id = auth.uid()
       and s.status = 'active'
       and s.current_period_end > now()
  );
$$;

comment on function public.has_intel_access is
  'True when the caller holds an active, unexpired Intelligence subscription. Every Pro
   data policy below defers to this, so access rules live in exactly one place.';

-- ------------------------------------------------------------------ the data -----------
-- Pay, demand and competition for one role in one place. Loaded nightly from
-- data/market_intel.json by push_intel_to_supabase.py.
create table if not exists public.intel_role_area (
  scope              text not null check (scope in ('national', 'state', 'metro')),
  area_key           text not null,              -- 'US', 'TX', or a CBSA code
  area_name          text,
  role               text not null,
  open_postings      integer not null default 0,
  employers          integer not null default 0,
  employer_names     text[],
  pay_p25            integer,
  pay_median         integer,
  pay_p75            integer,
  pay_postings       integer,
  pay_employers      integer,
  bls_soc            text,
  bls_precision      text,
  bls_pool           integer,
  bls_median_wage    integer,
  median_days_to_fill integer,     -- how long a search stays open; see time_to_fill.py
  updated_at         timestamptz not null default now(),
  primary key (scope, area_key, role)
);

-- Who is hiring, and whether they pay above the market for the same roles.
create table if not exists public.intel_employer (
  employer          text primary key,
  open_roles        integer not null default 0,
  states            integer not null default 0,
  discloses_pct     integer,
  median_advertised integer,
  pay_index         numeric(5, 3),               -- 1.13 = 13% above market for the same roles
  index_roles       integer,
  top_role          text,
  top_role_count    integer,
  updated_at        timestamptz not null default now()
);

-- Area-level context: workforce, what is being built, what we see posted.
create table if not exists public.intel_area (
  scope         text not null check (scope in ('national', 'state', 'metro')),
  area_key      text not null,
  area_name     text,
  workforce     integer,
  planned_mw    numeric(12, 1),
  open_postings integer,
  employers     integer,
  updated_at    timestamptz not null default now(),
  primary key (scope, area_key)
);

create index if not exists intel_role_area_role_idx on public.intel_role_area (role);
create index if not exists intel_role_area_area_idx on public.intel_role_area (scope, area_key);

-- ------------------------------------------------------------------ the paywall ---------
alter table public.intel_role_area enable row level security;
alter table public.intel_employer  enable row level security;
alter table public.intel_area      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['intel_role_area', 'intel_employer', 'intel_area'] loop
    execute format('drop policy if exists "subscribers read" on public.%I', t);
    execute format(
      'create policy "subscribers read" on public.%I for select to authenticated
         using (public.has_intel_access())', t);
    -- anon gets nothing: the free page is rendered server-side from the generator, so it
    -- never needs to read these tables.
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

grant select on public.intel_subscriptions to authenticated;
revoke all on public.intel_subscriptions from anon;

-- ------------------------------------------------------------------ granting ------------
-- Until Stripe is wired up, access is granted by hand. Run as the service role:
--
--   insert into public.intel_subscriptions (user_id, plan, current_period_end, note)
--   select id, 'pro', now() + interval '1 year', 'Founding customer - invoiced directly'
--     from auth.users where email = 'buyer@example.com'
--   on conflict (user_id) do update
--     set plan = excluded.plan,
--         status = 'active',
--         current_period_end = excluded.current_period_end,
--         updated_at = now();
--
-- To revoke: update public.intel_subscriptions set status = 'canceled' where user_id = '...';
