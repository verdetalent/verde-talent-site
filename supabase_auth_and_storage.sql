-- Link candidate profiles to real Supabase Auth accounts
alter table candidates add column user_id uuid references auth.users(id);
alter table candidates add column resume_path text;

-- Replace the old "anyone can insert" policy with account-scoped policies
drop policy if exists "Public can insert candidate profiles" on candidates;

create policy "Users can insert their own profile"
on candidates
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can view their own profile"
on candidates
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can update their own profile"
on candidates
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Storage: candidates can only upload/view files inside their own folder
-- (files will be stored as resumes/<user_id>/<filename>)
create policy "Users can upload their own resume"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can view their own resume"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = auth.uid()::text
);
