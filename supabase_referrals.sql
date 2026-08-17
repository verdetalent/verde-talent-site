-- Referral tracking, infrastructure-first: this wires up codes, links, and
-- counting so "refer 10 candidates" can be measured and shown accurately,
-- but the actual unlock (salary intelligence access) isn't built yet - the
-- reward gets bolted onto referral_count later without touching this schema.

-- Every candidate gets a short, unique, URL-safe code the moment their row
-- is created (both for the ~2,800 existing candidates, backfilled below,
-- and every new signup going forward via the column default) - their
-- shareable link is just create-profile.html?ref=<code>.
alter table candidates add column referral_code text;

update candidates
set referral_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)
where referral_code is null;

alter table candidates alter column referral_code set not null;
alter table candidates add constraint candidates_referral_code_key unique (referral_code);
alter table candidates alter column referral_code
  set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

-- One row per successful referral (a new candidate who signed up with a
-- ?ref= code in the URL) - referrer_code is stored as the raw code rather
-- than resolved to a candidate_id at insert time, so the anon-key signup
-- flow never needs read access to the candidates table to look anything
-- up (it just passes the code straight through blindly). unique on
-- referred_candidate_id means a candidate can only ever be credited to
-- whichever referral link they actually signed up through, once.
create table referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_code text not null,
  referred_candidate_id uuid not null references candidates(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (referred_candidate_id)
);

alter table referrals enable row level security;

-- Recorded at signup time via the anon key, same as the candidates insert
-- itself - no auth session exists yet at that point in the flow.
create policy "Anyone can record a referral at signup"
on referrals
for insert
to anon
with check (true);

-- A signed-in candidate can see (and count) only the referrals crediting
-- their own code - never anyone else's.
create policy "Candidates can see referrals crediting their own code"
on referrals
for select
to authenticated
using (referrer_code in (select referral_code from candidates where user_id = auth.uid()));
