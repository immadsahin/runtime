-- Phase 1 · Milestone 4 — Snapshot object storage.
--
-- A private, owner-scoped Supabase Storage bucket for Workspace Snapshot
-- artifacts (conversation, cast, git bundle + patch, summary, manifest). Bytes
-- are read/written only through short-lived signed URLs minted server-side; the
-- bucket is never public.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('workspace-snapshots', 'workspace-snapshots', false)
on conflict (id) do nothing;

-- Defense-in-depth RLS on the objects themselves. v0 reads/writes exclusively
-- via service-role-minted signed URLs (which bypass RLS), but this pins direct
-- authenticated access to an owner's own namespace: keys are
-- `archives/{owner_id}/{workspace_id}/{archivedAt}/{artifact}`, so the first
-- folder is 'archives' and the second is the owner's uid.
create policy workspace_snapshots_objects_owner_all on storage.objects
  for all to authenticated
  using (
    bucket_id = 'workspace-snapshots'
    and (storage.foldername(name))[1] = 'archives'
    and (storage.foldername(name))[2] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'workspace-snapshots'
    and (storage.foldername(name))[1] = 'archives'
    and (storage.foldername(name))[2] = (select auth.uid()::text)
  );
