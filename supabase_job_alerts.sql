-- Weekly job-match email alerts.
--
-- email is a deliberate denormalized copy of the candidate's auth.users
-- email - the alternative (looking it up via the Auth Admin API per
-- candidate at send time) would mean N extra API calls every week for what
-- is otherwise a single bulk query. Kept in sync at signup time only; this
-- table is never used as the source of truth for login.
alter table candidates add column email text;
alter table candidates add column email_job_alerts boolean not null default true;
alter table candidates add column unsubscribe_token uuid not null default gen_random_uuid();
alter table candidates add column last_job_alert_sent_at timestamptz;

-- unsubscribe_token is how the one-click link in an email works without
-- requiring the recipient to be logged in. No new RLS policy is needed for
-- this: the unsubscribe link hits a service-role Edge Function (like
-- send-application/stripe-webhook/manage-credits), which looks the
-- candidate up by token and flips email_job_alerts using the service role
-- key - a key that bypasses RLS entirely. The anon key never touches this
-- table for the unsubscribe flow, so candidates data stays exactly as
-- locked down as it already is.
