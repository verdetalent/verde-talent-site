-- Admin (you) can view every candidate profile, in addition to each
-- candidate only being able to view their own (existing policy stays).
create policy "Admin can view all candidates"
on candidates
for select
to authenticated
using (auth.jwt() ->> 'email' = 'contact@verdetalent.com');

-- Admin (you) can view every resume file in storage too.
create policy "Admin can view all resumes"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'resumes'
  and auth.jwt() ->> 'email' = 'contact@verdetalent.com'
);
