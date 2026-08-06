-- Schema behaviour assertions. Each block raises an exception on failure, so
-- the script fails loudly under `psql -v ON_ERROR_STOP=1`.

\set QUIET on
set client_min_messages to notice;

insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
       ('22222222-2222-2222-2222-222222222222', 'other@example.com');

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('11111111-1111-1111-1111-111111111111', 42,
        'immadsahin/runtime', 'immadsahin', 'runtime');

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('22222222-2222-2222-2222-222222222222', 84,
        'other/runtime', 'other', 'runtime');

-- 1. A repo may be synced only once per owner.
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 42,
          'immadsahin/runtime', 'immadsahin', 'runtime');
  raise exception 'FAIL: duplicate (owner, repo) was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate repo rejected';
end $$;

-- 2. A workspace cannot reference a project belonging to another owner.
do $$
declare other_project_id uuid;
begin
  select id into other_project_id from projects where owner_id = '22222222-2222-2222-2222-222222222222';
  insert into workspaces (owner_id, project_id, branch)
  values ('11111111-1111-1111-1111-111111111111', other_project_id, 'cross-owner');
  raise exception 'FAIL: workspace accepted another owner''s project';
exception when foreign_key_violation then
  raise notice 'ok: cross-owner project rejected';
end $$;

-- 3. Only one live workspace per (project, branch).
insert into workspaces (owner_id, project_id, branch)
select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;

do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;
  raise exception 'FAIL: second live workspace on same branch was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate live branch rejected';
end $$;

-- 4. Destroying a workspace frees the branch for reuse.
update workspaces set status = 'destroyed' where branch = 'feat/x';
insert into workspaces (owner_id, project_id, branch)
select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;

-- 5. Lifecycle actions use explicit in-progress enum values.
do $$
begin
  update workspaces set status = 'suspending'
  where branch = 'feat/x' and status <> 'destroyed';
  update workspaces set status = 'destroying'
  where branch = 'feat/x' and status <> 'destroyed';
  update workspaces set status = 'creating'
  where branch = 'feat/x' and status <> 'destroyed';
  raise notice 'ok: lifecycle transition states accepted';
end $$;

-- 6. At most one queued/running job per workspace.
insert into jobs (owner_id, workspace_id, prompt, status)
select '11111111-1111-1111-1111-111111111111', id, 'first', 'running'
from workspaces where status <> 'destroyed' limit 1;

do $$
begin
  insert into jobs (owner_id, workspace_id, prompt, status)
  select '11111111-1111-1111-1111-111111111111', id, 'second', 'queued'
  from workspaces where status <> 'destroyed' limit 1;
  raise exception 'FAIL: concurrent job in one workspace was allowed';
exception when unique_violation then
  raise notice 'ok: concurrent job rejected';
end $$;

-- 7. A finished job frees the slot.
update jobs set status = 'succeeded' where prompt = 'first';

-- 7a. Jobs default to Claude for backwards compatibility and accept Codex.
do $$
declare agent_name text;
begin
  insert into jobs (owner_id, workspace_id, prompt)
  select '11111111-1111-1111-1111-111111111111', id, 'default agent'
  from workspaces where status <> 'destroyed' limit 1
  returning agent into agent_name;
  if agent_name <> 'claude' then
    raise exception 'FAIL: job agent did not default to Claude';
  end if;
  update jobs set status = 'succeeded' where prompt = 'default agent';
  insert into jobs (owner_id, workspace_id, prompt, agent)
  select '11111111-1111-1111-1111-111111111111', id, 'codex agent', 'codex'
  from workspaces where status <> 'destroyed' limit 1;
  update jobs set status = 'succeeded' where prompt = 'codex agent';
  raise notice 'ok: job agent values accepted';
end $$;

do $$
begin
  insert into jobs (owner_id, workspace_id, prompt, agent)
  select '11111111-1111-1111-1111-111111111111', id, 'invalid agent', 'unknown'
  from workspaces where status <> 'destroyed' limit 1;
  raise exception 'FAIL: invalid job agent was allowed';
exception when check_violation then
  raise notice 'ok: invalid job agent rejected';
end $$;

-- 8. A job cannot reference a workspace belonging to another owner.
do $$
declare owner_workspace_id uuid;
begin
  select id into owner_workspace_id from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into jobs (owner_id, workspace_id, prompt)
  values ('22222222-2222-2222-2222-222222222222', owner_workspace_id, 'cross-owner');
  raise exception 'FAIL: job accepted another owner''s workspace';
exception when foreign_key_violation then
  raise notice 'ok: cross-owner workspace rejected';
end $$;

-- 9. A finished job leaves room for the next queued job.
insert into jobs (owner_id, workspace_id, prompt, status)
select '11111111-1111-1111-1111-111111111111', id, 'second', 'queued'
from workspaces where status <> 'destroyed' limit 1;

-- 10. updated_at is maintained by trigger.
do $$
declare touched boolean;
begin
  update jobs set status = 'running' where prompt = 'second';
  select updated_at > created_at into touched from jobs where prompt = 'second';
  if not touched then
    raise exception 'FAIL: updated_at trigger did not fire';
  end if;
  raise notice 'ok: updated_at trigger fires';
end $$;

-- 11. Pull requests are owner-scoped and one-to-one with a workspace.
insert into pull_requests (
  owner_id, workspace_id, github_number, url, title, base_branch, head_branch
)
select
  '11111111-1111-1111-1111-111111111111', id, 7,
  'https://github.com/immadsahin/runtime/pull/7', 'Runtime test', 'main', 'feat/x'
from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;

do $$
declare workspace uuid;
begin
  select id into workspace from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into pull_requests (
    owner_id, workspace_id, github_number, url, title, base_branch, head_branch
  ) values (
    '11111111-1111-1111-1111-111111111111', workspace, 8,
    'https://github.com/immadsahin/runtime/pull/8', 'Duplicate', 'main', 'feat/x'
  );
  raise exception 'FAIL: duplicate workspace pull request was allowed';
exception when unique_violation then
  raise notice 'ok: one pull request per workspace enforced';
end $$;

-- 12. Runtime Computer placements are provider-scoped, immutable, and retain
-- their original image version across the legacy claim overload.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare
  claimed_project_id uuid;
  workspace_id uuid;
  daytona_id uuid;
  e2b_id uuid;
  should_create boolean;
begin
  select id into claimed_project_id from projects
    where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  select id into workspace_id from workspaces
    where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;

  select runtime_computer_id, should_provision into daytona_id, should_create
  from claim_runtime_computer(
    claimed_project_id, 'project:' || claimed_project_id::text, 'daytona', 'shared', 'secret-1', 'runtime-computer-v1'
  );
  if not should_create then raise exception 'FAIL: first Daytona placement was not claimable'; end if;

  -- During a rolling deploy, an older revision writes only the legacy Daytona
  -- handle while a newer revision reads provider_computer_id. The migration
  -- must keep the two columns synchronized in both directions.
  update runtime_computers
  set daytona_sandbox_id = 'legacy-daytona-handle'
  where id = daytona_id;
  if not exists (
    select 1 from runtime_computers
    where id = daytona_id
      and provider_computer_id = 'legacy-daytona-handle'
      and daytona_sandbox_id = 'legacy-daytona-handle'
  ) then
    raise exception 'FAIL: legacy Daytona handle was not synchronized';
  end if;

  update runtime_computers
  set provider_computer_id = 'provider-daytona-handle'
  where id = daytona_id;
  if not exists (
    select 1 from runtime_computers
    where id = daytona_id
      and provider_computer_id = 'provider-daytona-handle'
      and daytona_sandbox_id = 'provider-daytona-handle'
  ) then
    raise exception 'FAIL: provider Daytona handle was not synchronized';
  end if;

  -- The historical three-argument RPC must resolve the same placement and use
  -- its existing immutable image_version rather than its legacy default.
  select runtime_computer_id, should_provision into e2b_id, should_create
  from claim_runtime_computer(claimed_project_id, 'secret-2');
  if e2b_id <> daytona_id or should_create then
    raise exception 'FAIL: legacy claim did not reuse the Daytona placement';
  end if;

  select runtime_computer_id, should_provision into e2b_id, should_create
  from claim_runtime_computer(
    claimed_project_id, 'workspace:' || workspace_id::text, 'e2b', 'isolated', 'secret-3', 'e2b-v1'
  );
  if not should_create or e2b_id = daytona_id then
    raise exception 'FAIL: isolated E2B placement was not independently claimable';
  end if;

  begin
    perform claim_runtime_computer(
      claimed_project_id, 'project:' || claimed_project_id::text, 'daytona', 'shared', 'secret-4', 'different-v1'
    );
    raise exception 'FAIL: mutable Runtime Computer image_version was allowed';
  exception when raise_exception then
    if sqlerrm <> 'Runtime Computer placement is immutable' then raise; end if;
  end;

  begin
    update runtime_computers set topology = 'isolated' where id = daytona_id;
    raise exception 'FAIL: mutable Runtime Computer topology was allowed';
  exception when raise_exception then
    if sqlerrm <> 'Runtime Computer placement is immutable' then raise; end if;
  end;

  -- An unconfirmed provider cleanup must retain its handle and block automatic
  -- reprovisioning, rather than creating a second potentially billed computer.
  update runtime_computers
  set status = 'error', provider_computer_id = 'unconfirmed-cleanup-handle'
  where id = e2b_id;
  begin
    perform claim_runtime_computer(
      claimed_project_id, 'workspace:' || workspace_id::text, 'e2b', 'isolated', 'secret-5', 'e2b-v1'
    );
    raise exception 'FAIL: computer with unconfirmed cleanup was reprovisioned';
  exception when raise_exception then
    if sqlerrm <> 'Runtime Computer cleanup is incomplete' then raise; end if;
  end;

  -- Deleting a Runtime Computer must retain its workspace's required owner and
  -- project identity while clearing only the optional computer reference.
  update workspaces set computer_id = e2b_id where id = workspace_id;
  delete from runtime_computers where id = e2b_id;
  if not exists (
    select 1 from workspaces w
    where w.id = workspace_id
      and w.owner_id = '11111111-1111-1111-1111-111111111111'
      and w.project_id = claimed_project_id
      and w.computer_id is null
  ) then
    raise exception 'FAIL: deleting a Runtime Computer did not retain its workspace';
  end if;

  raise notice 'ok: Runtime Computer placement identity is immutable';
end $$;

-- 13. RLS isolates rows by owner.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authed') then
    create role authed nologin;
  end if;
  grant usage on schema public to authed;
  grant all on all tables in schema public to authed;
end $do$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n integer;
begin
  select count(*) into n from projects where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % project rows to another user', n;
  end if;
  select count(*) into n from workspaces where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % workspace rows', n;
  end if;
  select count(*) into n from jobs where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % job rows', n;
  end if;
  select count(*) into n from pull_requests where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % pull request rows', n;
  end if;
  raise notice 'ok: RLS hides other owners'' rows';
end $$;

-- 14. RLS rejects inserts that forge another owner.
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 99, 'x/y', 'x', 'y');
  raise exception 'FAIL: forged owner_id insert was allowed';
exception when insufficient_privilege then
  raise notice 'ok: forged owner_id insert rejected';
end $$;

reset role;
