-- Adds an inferred (IP-geolocation at signup, not user-entered) two-letter
-- US state code to each subscriber, so newsletter-weekly can match its
-- Featured jobs sidebar to where the subscriber actually is instead of
-- showing whatever state happens to be first in the general jobs feed.
-- Nullable - geolocation can fail, or the subscriber can be outside the
-- US, and the newsletter falls back to its unfiltered recent list when
-- this is null. Populated by the subscribe-newsletter Edge Function, not
-- by any direct client insert.
alter table newsletter_subscribers
  add column location text;
