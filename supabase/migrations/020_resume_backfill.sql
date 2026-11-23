-- 020: one-off backfill of resume bullets / summary / skills into profiles made before 2026-11-23.
-- Only contact@verdetalent.com can call these. They only ever fill EMPTY fields, and keep the
-- before-state so any profile can be put back.

create table if not exists resume_backfill_log (
  id            bigint generated always as identity primary key,
  candidate_id  uuid not null references candidates(id) on delete cascade,
  created_at    timestamptz not null default now(),
  before_experience jsonb,
  before_bio        text,
  before_skills     text[],
  after_experience  jsonb,
  after_bio         text,
  after_skills      text[],
  bullets_added int not null default 0,
  undone_at     timestamptz
);
alter table resume_backfill_log enable row level security;
create policy "Admin reads backfill log" on resume_backfill_log
  for select to authenticated using (auth.jwt() ->> 'email' = 'contact@verdetalent.com');

-- p_jobs: [{"i": 0, "title": "Solar Technician", "bullets": ["...", "..."]}, ...]
--   i = position in the profile's experience list; title must still match there,
--   and that job must still have no bullets, or it is skipped.
-- p_bio / p_skills: only used when the profile's bio / skills are empty.
create or replace function admin_backfill_profile(p_id uuid, p_jobs jsonb, p_bio text, p_skills text[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c candidates%rowtype;
  exp jsonb;
  j jsonb;
  idx int;
  cur jsonb;
  added int := 0;
  new_bio text;
  new_skills text[];
begin
  if coalesce(auth.jwt() ->> 'email', '') <> 'contact@verdetalent.com' then
    raise exception 'not allowed';
  end if;
  select * into c from candidates where id = p_id for update;
  if not found then raise exception 'no such profile'; end if;

  exp := coalesce(c.experience, '[]'::jsonb);
  for j in select * from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) loop
    idx := (j ->> 'i')::int;
    if idx is null or idx < 0 or idx >= jsonb_array_length(exp) then continue; end if;
    cur := exp -> idx;
    if lower(trim(coalesce(cur ->> 'title', ''))) <> lower(trim(coalesce(j ->> 'title', ''))) then continue; end if;
    if jsonb_array_length(coalesce(cur -> 'bullets', '[]'::jsonb)) > 0 then continue; end if;
    if jsonb_typeof(j -> 'bullets') <> 'array' or jsonb_array_length(j -> 'bullets') = 0 then continue; end if;
    exp := jsonb_set(exp, array[idx::text], cur || jsonb_build_object('bullets', j -> 'bullets'));
    added := added + jsonb_array_length(j -> 'bullets');
  end loop;

  new_bio := case when coalesce(trim(c.bio), '') = '' and coalesce(trim(p_bio), '') <> '' then left(p_bio, 500) else c.bio end;
  new_skills := case when coalesce(array_length(c.skills, 1), 0) = 0 and coalesce(array_length(p_skills, 1), 0) > 0 then p_skills else c.skills end;

  if added = 0 and new_bio is not distinct from c.bio and new_skills is not distinct from c.skills then
    return jsonb_build_object('changed', false);
  end if;

  insert into resume_backfill_log (candidate_id, before_experience, before_bio, before_skills,
                                   after_experience, after_bio, after_skills, bullets_added)
  values (p_id, c.experience, c.bio, c.skills, exp, new_bio, new_skills, added);

  update candidates set experience = exp, bio = new_bio, skills = new_skills where id = p_id;
  return jsonb_build_object('changed', true, 'bullets_added', added,
    'bio_added', new_bio is distinct from c.bio, 'skills_added', new_skills is distinct from c.skills);
end $$;

-- Put one backfill back - but only if the candidate hasn't edited those fields since.
create or replace function admin_backfill_undo(p_log_id bigint)
returns text
language plpgsql security definer set search_path = public
as $$
declare l resume_backfill_log%rowtype; c candidates%rowtype;
begin
  if coalesce(auth.jwt() ->> 'email', '') <> 'contact@verdetalent.com' then
    raise exception 'not allowed';
  end if;
  select * into l from resume_backfill_log where id = p_log_id and undone_at is null;
  if not found then return 'nothing to undo'; end if;
  select * into c from candidates where id = l.candidate_id for update;
  if c.experience is distinct from l.after_experience or c.bio is distinct from l.after_bio
     or c.skills is distinct from l.after_skills then
    return 'skipped: the candidate has edited their profile since';
  end if;
  update candidates set experience = l.before_experience, bio = l.before_bio, skills = l.before_skills
   where id = l.candidate_id;
  update resume_backfill_log set undone_at = now() where id = p_log_id;
  return 'undone';
end $$;

revoke all on function admin_backfill_profile(uuid, jsonb, text, text[]) from public, anon;
revoke all on function admin_backfill_undo(bigint) from public, anon;
grant execute on function admin_backfill_profile(uuid, jsonb, text, text[]) to authenticated;
grant execute on function admin_backfill_undo(bigint) to authenticated;
