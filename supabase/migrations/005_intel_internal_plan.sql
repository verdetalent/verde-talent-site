-- A third plan label, 'internal', for the site owner, staff and complimentary accounts, so
-- 'pro' and 'enterprise' only ever mean paying customers. Access is unaffected:
-- has_intel_access() checks status and end date, never the plan.
--
-- Run after 001_intelligence_pro.sql. Safe to re-run.

alter table public.intel_subscriptions drop constraint if exists intel_subscriptions_plan_check;
alter table public.intel_subscriptions add constraint intel_subscriptions_plan_check
  check (plan in ('pro', 'enterprise', 'internal'));

-- The owner account, open-ended:
--
--   update public.intel_subscriptions s
--      set plan = 'internal', current_period_end = '2099-12-31', note = 'Site owner - no expiry', updated_at = now()
--     from auth.users u
--    where u.id = s.user_id and u.email = 'contact@verdetalent.com';
