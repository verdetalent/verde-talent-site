-- Zero-commitment job alert signup: email + sector + location, no account
-- required. Deliberately a separate table from candidates - these people
-- never create a password or a full profile, so they shouldn't live in the
-- same table as real candidate accounts. job-alerts-weekly sends to both
-- tables (see that Edge Function), matching leads on sector + location only
-- (no job-title/category refinement, since there's no headline/experience
-- to infer one from) - each email includes a nudge to upgrade to a full
-- profile for better-matched results.
create table job_alert_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text not null,
  sector text not null,
  location text not null,
  subscribed boolean not null default true,
  unsubscribe_token uuid not null default gen_random_uuid(),
  last_alert_sent_at timestamptz,
  unique (email, sector)
);

alter table job_alert_leads enable row level security;

-- Anyone can sign up. No select/update/delete for anon - reads/writes for
-- sending and unsubscribing go through service-role Edge Functions, same
-- pattern as newsletter_subscribers and candidates.
create policy "Public can sign up for job alerts"
on job_alert_leads
for insert
to anon
with check (true);
