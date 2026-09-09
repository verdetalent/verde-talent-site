-- Per-recipient Resend delivery/engagement events (sent, delivered, bounced,
-- complained, opened, clicked) for newsletter_subscribers sends. This is the
-- gauge for actual deliverability - Resend's own dashboard shows aggregate
-- numbers, but a per-subscriber history is what lets us catch a recipient
-- whose bounces/complaints are quietly dragging the sending domain's
-- reputation down before it shows up as a wider inbox-placement problem.
create table newsletter_events (
  id uuid primary key default gen_random_uuid(),
  -- Svix's per-delivery id (the "svix-id" header). Resend/Svix retries a
  -- webhook delivery on a non-2xx response and reuses this same id on
  -- retry, so a unique constraint on it is what makes the insert below
  -- idempotent without needing a separate upsert-and-check step.
  svix_id text not null unique,
  event_type text not null, -- email.sent / .delivered / .delivery_delayed / .complained / .bounced / .opened / .clicked
  resend_email_id text not null,
  subscriber_email text,
  occurred_at timestamptz not null,
  raw jsonb not null,
  created_at timestamptz not null default now()
);

create index newsletter_events_email_idx on newsletter_events (subscriber_email);
create index newsletter_events_type_created_idx on newsletter_events (event_type, created_at desc);

alter table newsletter_events enable row level security;

-- No policies for anon/authenticated - this table is written only by the
-- resend-webhook Edge Function (service role, bypasses RLS) and read only
-- via the Supabase dashboard / service-role queries, same pattern as
-- newsletter_subscribers itself.
