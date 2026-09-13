-- Optional job title typed at newsletter signup (news.html). newsletter-weekly
-- maps it to a role type (same rules as job-alerts-weekly) to put matching
-- roles first in the subscriber's Featured jobs, and only lets a paid
-- posting lead when it fits both their area and their role. Nullable - the
-- box is optional, and earlier subscribers have none (location-only
-- matching, as before). Written only by the subscribe-newsletter function.
alter table newsletter_subscribers
  add column if not exists job_title text;
