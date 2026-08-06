-- Provider-neutral Runtime Computer identity. Existing Daytona rows retain
-- their project-scoped shared placement; isolated providers receive one row per
-- workspace-scoped placement key. A workspace never re-schedules its key.

alter table runtime_computers
  add column compute_provider text not null default 'daytona',
  add column placement_key text,
  add column topology text not null default 'shared'
    check (topology in ('shared', 'isolated')),
  add column provider_computer_id text,
  add constraint runtime_computers_compute_provider_check
    check (compute_provider in ('daytona', 'e2b'));

update runtime_computers
set placement_key = 'project:' || project_id::text,
    provider_computer_id = daytona_sandbox_id
where placement_key is null;

alter table runtime_computers
  alter column placement_key set not null,
  drop constraint runtime_computers_project_unique,
  add constraint runtime_computers_provider_placement_unique
    unique (compute_provider, placement_key),
  add constraint runtime_computers_owner_project_id_unique
    unique (owner_id, project_id, id);

-- A workspace may only attach to a Runtime Computer owned by the same user and
-- project. The previous FK was owner-scoped, which was insufficient once a
-- project can have both a shared and isolated placement.
alter table workspaces
  drop constraint workspaces_computer_fkey,
  add constraint workspaces_computer_fkey
    foreign key (owner_id, project_id, computer_id)
    references runtime_computers (owner_id, project_id, id)
    on delete set null;

-- New callers use this provider-neutral, immutable placement claim. Retain the
-- historical overload so older deployed app revisions keep their Daytona
-- behavior during a rolling migration.
create function claim_runtime_computer(
  requested_project_id uuid,
  requested_placement_key text,
  requested_compute_provider text,
  requested_topology text,
  requested_agent_secret text,
  requested_image_version text
)
returns table (runtime_computer_id uuid, should_provision boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
  requested_workspace_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if requested_compute_provider not in ('daytona', 'e2b') then
    raise exception 'invalid compute provider';
  end if;
  if requested_topology not in ('shared', 'isolated') then
    raise exception 'invalid compute topology';
  end if;
  if (requested_compute_provider = 'daytona' and requested_topology <> 'shared')
    or (requested_compute_provider = 'e2b' and requested_topology <> 'isolated') then
    raise exception 'compute provider does not support requested topology';
  end if;
  perform 1 from projects where id = requested_project_id and owner_id = auth.uid();
  if not found then raise exception 'project not found'; end if;
  if requested_topology = 'shared' then
    if requested_placement_key <> ('project:' || requested_project_id::text) then
      raise exception 'invalid shared placement key';
    end if;
  else
    if requested_placement_key !~ '^workspace:[0-9a-f-]{36}$' then
      raise exception 'invalid isolated placement key';
    end if;
    requested_workspace_id := substring(requested_placement_key from 11)::uuid;
    perform 1 from workspaces
      where id = requested_workspace_id and project_id = requested_project_id and owner_id = auth.uid();
    if not found then raise exception 'workspace not found'; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(requested_compute_provider || ':' || requested_placement_key));
  select * into existing from runtime_computers
    where compute_provider = requested_compute_provider and placement_key = requested_placement_key;
  if found then
    if existing.project_id <> requested_project_id
      or existing.topology <> requested_topology
      or existing.image_version <> requested_image_version then
      raise exception 'Runtime Computer placement is immutable';
    end if;
    runtime_computer_id := existing.id;
    if existing.status in ('error', 'stopped') then
      update runtime_computers set status = 'provisioning', agent_secret = requested_agent_secret,
        provider_computer_id = null, agent_base_url = null, provision_timings = null,
        error_message = null where id = existing.id;
      should_provision := true;
    else should_provision := false;
    end if;
    return next; return;
  end if;

  insert into runtime_computers (
    owner_id, project_id, compute_provider, placement_key, topology, agent_secret, image_version, status
  ) values (
    auth.uid(), requested_project_id, requested_compute_provider, requested_placement_key,
    requested_topology, requested_agent_secret, requested_image_version, 'provisioning'
  ) returning id into runtime_computer_id;
  should_provision := true;
  return next;
end;
$$;

-- Preserve the historical three-argument RPC during a rolling deploy.  The
-- old implementation selected by project_id, which is no longer unique once
-- isolated computers exist; delegate it to the shared Daytona placement
-- instead so an older application revision cannot select an E2B row.
create or replace function claim_runtime_computer(
  requested_project_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1'
)
returns table (runtime_computer_id uuid, should_provision boolean)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select * from claim_runtime_computer(
    requested_project_id,
    'project:' || requested_project_id::text,
    'daytona',
    'shared',
    requested_agent_secret,
    coalesce(
      (
        select image_version from runtime_computers
        where compute_provider = 'daytona'
          and placement_key = 'project:' || requested_project_id::text
      ),
      requested_image_version
    )
  );
$$;

-- A provider, topology, placement key, and image version describe where a
-- workspace executes. They are selected once, persisted before provisioning,
-- and must never be changed by a later update or restore.
create function runtime_computer_placement_is_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.owner_id is distinct from old.owner_id
    or new.project_id is distinct from old.project_id
    or new.compute_provider is distinct from old.compute_provider
    or new.placement_key is distinct from old.placement_key
    or new.topology is distinct from old.topology
    or new.image_version is distinct from old.image_version then
    raise exception 'Runtime Computer placement is immutable';
  end if;
  return new;
end;
$$;

create trigger runtime_computers_placement_immutable
  before update on runtime_computers
  for each row execute function runtime_computer_placement_is_immutable();

-- The claim RPC is the normal insertion path, but RLS also permits an owner to
-- insert their own rows. Apply the same placement-shape checks at the table so
-- direct writes cannot fabricate an E2B workspace placement or a shared key.
create function runtime_computer_placement_is_valid()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  placement_workspace_id uuid;
begin
  if (new.compute_provider = 'daytona' and new.topology <> 'shared')
    or (new.compute_provider = 'e2b' and new.topology <> 'isolated') then
    raise exception 'compute provider does not support requested topology';
  end if;
  if new.topology = 'shared' then
    if new.placement_key <> ('project:' || new.project_id::text) then
      raise exception 'invalid shared placement key';
    end if;
  else
    if new.placement_key !~ '^workspace:[0-9a-f-]{36}$' then
      raise exception 'invalid isolated placement key';
    end if;
    placement_workspace_id := substring(new.placement_key from 11)::uuid;
    perform 1 from workspaces
      where id = placement_workspace_id
        and project_id = new.project_id
        and owner_id = new.owner_id;
    if not found then raise exception 'workspace not found'; end if;
  end if;
  return new;
end;
$$;

create trigger runtime_computers_placement_valid
  before insert on runtime_computers
  for each row execute function runtime_computer_placement_is_valid();
