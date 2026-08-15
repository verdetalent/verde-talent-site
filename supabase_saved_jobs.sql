-- "Save this job" - a bookmark, not an application. Every visitor can save
-- to their browser's localStorage with zero friction (no account needed);
-- signed-in candidates additionally get their saves synced here so they
-- carry across devices. save_key is job.job_posting_id-prefixed
-- ("employer:<id>") for paid employer postings or the crawler's page_slug
-- for everything else - the same identifier scheme jobs.html already uses
-- to build each job card's href, so no new ID scheme was introduced.
-- job_title/company/location are denormalized copies at save time so the
-- saved-jobs page can render without a join back to a job that may have
-- since closed and been removed.
create table saved_jobs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  save_key text not null,
  job_title text,
  company text,
  location text,
  saved_at timestamptz not null default now(),
  unique (candidate_id, save_key)
);

alter table saved_jobs enable row level security;

-- Same ownership pattern as candidates' own RLS: a signed-in user can only
-- ever touch the saved_jobs rows belonging to their own candidate record,
-- looked up via candidates.user_id = auth.uid() (never a bare candidate_id
-- passed by the client, which would let anyone read/write anyone else's
-- saves just by guessing a uuid).
create policy "Candidates manage their own saved jobs"
on saved_jobs
for all
to authenticated
using (candidate_id in (select id from candidates where user_id = auth.uid()))
with check (candidate_id in (select id from candidates where user_id = auth.uid()));
