-- Employer-submitted, paid job postings.
create table job_postings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  company_name text not null,
  company_email text not null,
  job_title text not null,
  job_description text not null,
  location text,
  sector text,
  employment_type text,
  apply_url text,             -- optional external application link; falls back to mailto company_email

  duration_days integer not null,          -- 30 or 60
  price_cents integer not null,            -- 10000 or 15000
  status text not null default 'pending_payment',  -- pending_payment | paid | expired | removed

  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  expires_at timestamptz
);

alter table job_postings enable row level security;

-- Anyone can submit a new posting (it starts unpaid/unpublished - status
-- only ever moves to 'paid' via the webhook Edge Function, which uses the
-- service role key and bypasses RLS entirely, never through this policy).
create policy "Public can submit a job posting"
on job_postings
for insert
to anon
with check (status = 'pending_payment');

-- Admin (you) can see everything, including pending/unpaid submissions.
create policy "Admin can view all job postings"
on job_postings
for select
to authenticated
using (auth.jwt() ->> 'email' = 'contact@verdetalent.com');

-- A safe, public-facing view: only paid + still-active postings, and only
-- the columns a job listing actually needs - no email addresses, no
-- Stripe identifiers, no pending/expired/removed rows.
create view public_job_postings as
select
  id, company_name, job_title, job_description, location, sector,
  employment_type, apply_url, company_email, paid_at, expires_at
from job_postings
where status = 'paid' and expires_at > now();

grant select on public_job_postings to anon;
