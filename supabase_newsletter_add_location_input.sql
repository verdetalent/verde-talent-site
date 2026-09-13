-- Newsletter location is now typed by the subscriber (optional "City, State,
-- or ZIP" box on news.html) instead of inferred from their IP - the
-- ip-api.com lookup is gone. subscribe-newsletter still derives the
-- two-letter state into `location` (what newsletter-weekly matches its
-- Featured jobs on); this keeps the raw text too, so the newsletter can move
-- to the same 100-mile city/ZIP matching as job alerts later without asking
-- anyone again. Nullable - the box is optional, and rows from before this
-- have none. Written only by the subscribe-newsletter Edge Function.
alter table newsletter_subscribers
  add column if not exists location_input text;
