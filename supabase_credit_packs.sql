-- Bulk job-posting credit packs. Each row is one purchased batch (a
-- ledger, not a single balance number) because different batches expire
-- at different times - a 5-pack bought today and a 10-pack bought next
-- month don't expire together, so the remaining-credits math has to be
-- tracked per-batch, not as one running total.
create table employer_credit_purchases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  employer_user_id uuid not null references auth.users(id),
  pack_size integer not null,               -- 5 or 10
  price_cents integer not null,             -- 45000 or 85000
  credits_remaining integer not null,       -- starts at pack_size, decremented as redeemed

  status text not null default 'pending_payment',  -- pending_payment | paid
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  expires_at timestamptz                    -- set to paid_at + 12 months once paid
);

alter table employer_credit_purchases enable row level security;

-- Unlike job_postings, credits always require a signed-in employer
-- account (there's no anonymous credit purchase path), so the insert
-- policy checks auth.uid() directly instead of allowing the anon role.
create policy "Employers can start their own credit purchase"
on employer_credit_purchases
for insert
to authenticated
with check (employer_user_id = auth.uid() and status = 'pending_payment');

-- Admin (you) can see everything, same pattern as job_postings.
create policy "Admin can view all credit purchases"
on employer_credit_purchases
for select
to authenticated
using (auth.jwt() ->> 'email' = 'contact@verdetalent.com');

-- Marks which job postings were paid for with a credit instead of a real
-- Stripe charge, so it's visible in the data which is which.
alter table job_postings
  add column paid_via_credit boolean not null default false;
