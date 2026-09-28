-- The dataset behind the Intelligence pages (employer-intel-home.html and
-- employer-intelligence.html), readable only with an active subscription.
--
-- The pages were designed against one document: every state, metro, role and sector, with
-- BLS pay, advertised pay, time to fill, pipeline, workforce and the rest. Rebuilding that
-- shape from normalised rows in the browser would mean dozens of queries per page load and
-- a second copy of the generator's logic in JavaScript. So the generator builds the
-- document (build_intel_dataset.py) and stores it here in three parts, and the page reads
-- all three in one request.
--
-- It lives in Postgres, not in a file on the site, because anything on GitHub Pages can be
-- downloaded by anyone. Row-level security below is the paywall: a signed-in employer
-- without Intelligence gets zero rows, not an error, and the page shows the locked view.
--
-- Size: about 1.5 MB of JSON across the three rows, replaced nightly. Well inside the free
-- tier, which allows 500 MB.
--
-- Run after 001_intelligence_pro.sql (it uses has_intel_access()). Safe to re-run.

create table if not exists public.intel_dataset (
  part         text primary key check (part in ('core', 'states', 'metros')),
  data         jsonb not null,
  generated_on date not null,
  updated_at   timestamptz not null default now()
);

comment on table public.intel_dataset is
  'The Intelligence pages'' dataset in three parts (core, states, metros), replaced nightly
   by push_intel_to_supabase.py with the service role. Readable only by subscribers.';

alter table public.intel_dataset enable row level security;

drop policy if exists "subscribers read" on public.intel_dataset;
create policy "subscribers read" on public.intel_dataset
  for select to authenticated
  using (public.has_intel_access());

revoke all on public.intel_dataset from anon;
grant select on public.intel_dataset to authenticated;

-- Lets a page ask "does this account have Intelligence?" without reading 1.5 MB to find
-- out. has_intel_access() already exists; this only makes sure a signed-in user can call
-- it and anon cannot.
revoke all on function public.has_intel_access() from public, anon;
grant execute on function public.has_intel_access() to authenticated;
