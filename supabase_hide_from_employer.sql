-- "Hide my profile from my current employer".
--
-- Two new fields on each candidate profile:
--   hide_from_current_employer  true = employer accounts at current_employer must not be able to see this
--                                profile. On by default, so existing profiles are protected too.
--   current_employer            the company name the candidate gave (pre-filled from the job on their
--                                resume that is still running).
--
-- employer_name_key() reduces a company name to a comparable key, so "Sunrun, Inc." and "SUNRUN"
-- match. It deliberately strips only legal suffixes and a few generic words (Inc, LLC, Corp, Group,
-- Energy, Renewables, North America...). A false match hides a profile from one extra company, which
-- is the safe direction; a missed match would expose it, so keep the list conservative to extend.
--
-- NOTHING here lets an employer read candidates. Candidate rows are still readable only by their owner
-- and the admin (see supabase_auth_and_storage.sql and supabase_admin_policies.sql). When employer
-- access is opened, its policy MUST exclude rows where hide_from_current_employer is true and
-- employer_name_key(current_employer) matches the employer account's own company key.

alter table candidates add column if not exists hide_from_current_employer boolean default true;
alter table candidates add column if not exists current_employer text;

-- Existing profiles: protected by default, with no employer name yet.
update candidates set hide_from_current_employer = true where hide_from_current_employer is null;

create or replace function employer_name_key(name text) returns text
language sql immutable as $$
  select nullif(
    trim(regexp_replace(
      regexp_replace(
        regexp_replace(lower(coalesce(name, '')),
          '\m(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|plc|lp|llp|group|holdings|renewables?|energy|usa|us|north america|americas)\M', ' ', 'g'),
        '[^a-z0-9]+', ' ', 'g'),
      '\s+', ' ', 'g')),
    '');
$$;
