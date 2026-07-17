create table candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  first_name text not null,
  last_name text not null,
  headline text,
  location text,
  years_experience text,
  bio text,
  sectors text[],
  skills text[],
  experience jsonb,
  education jsonb,
  work_style text[],
  job_type text,
  relocation text,
  salary_min integer,
  salary_max integer,
  availability text,
  linkedin_url text,
  website_url text,
  github_url text,
  resume_filename text,
  visibility_recruiters boolean default true,
  visibility_salary boolean default true,
  visibility_employer boolean default false,
  visibility_searchable boolean default true
);

alter table candidates enable row level security;

-- Anyone using the public key can submit a new profile...
create policy "Public can insert candidate profiles"
on candidates
for insert
to anon
with check (true);

-- ...but nobody using the public key can read, edit, or delete rows.
-- (You'll view/manage data from the Supabase dashboard, or a future
-- admin page that uses a properly authenticated connection.)
