-- Open-to-anyone newsletter subscription (not tied to a candidate/employer
-- account - literally anyone visiting the site can subscribe from any page
-- that has the subscribe widget on it).
create table newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text not null unique,
  subscribed boolean not null default true,
  unsubscribe_token uuid not null default gen_random_uuid()
);

alter table newsletter_subscribers enable row level security;

-- Anyone can subscribe. No select/update/delete policy for anon - reading,
-- unsubscribing, etc. all go through service-role Edge Functions, same
-- pattern as the job-alerts unsubscribe flow.
create policy "Public can subscribe to the newsletter"
on newsletter_subscribers
for insert
to anon
with check (true);
