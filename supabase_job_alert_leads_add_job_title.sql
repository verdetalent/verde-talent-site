-- job_alert_leads already exists in production (created by
-- supabase_job_alert_leads.sql) - this adds the job_title column the
-- lite-alert box on create-profile.html now collects, used to narrow
-- matches by job category the same way candidates.headline does.
alter table job_alert_leads add column job_title text;
