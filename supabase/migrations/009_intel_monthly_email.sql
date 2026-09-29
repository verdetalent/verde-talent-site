-- The monthly email records which month each subscriber was last sent, so a cron double-fire
-- or a manual re-run never sends anyone the same report twice.
--
-- Run after 008. Safe to re-run.

alter table public.intel_subscriptions
  add column if not exists last_report_month text;   -- 'YYYY-MM'
