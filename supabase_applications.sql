-- Tracks resume-forward applications sent through Verde Talent (only for
-- paid job_postings that had no apply_url - everything else links straight
-- to the employer/ATS's own site and we're never involved in delivery).
create table applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job_posting_id uuid not null references job_postings(id),
  candidate_user_id uuid not null references auth.users(id),
  status text not null default 'sent',  -- sent | failed
  unique (job_posting_id, candidate_user_id)
);

alter table applications enable row level security;

-- A candidate can see their own application history (e.g. to show
-- "Already applied" instead of Apply on a job they've already sent a
-- resume to). Rows are only ever written by the send-application Edge
-- Function using the service role key, never directly by a client.
create policy "Candidates can view their own applications"
on applications
for select
to authenticated
using (auth.uid() = candidate_user_id);
