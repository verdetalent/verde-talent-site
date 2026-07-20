-- Associates a job posting with the employer's Supabase Auth account (if
-- they were signed in when they posted it), so a dashboard can list "my
-- postings" without needing the per-posting secret manage_token. Nullable
-- because postings can still be submitted without an account - those are
-- matched in the dashboard by company_email instead (handled in the
-- manage-posting Edge Function, not via RLS, since all reads there go
-- through the service-role client).
alter table job_postings
  add column employer_user_id uuid references auth.users(id);
