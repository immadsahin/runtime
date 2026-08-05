-- Claim the one Runtime Computer slot for a project before provisioning
-- external Daytona compute. The transaction-scoped advisory lock eliminates
-- the read-then-insert race; the unique constraint remains the durable guard.
--
-- A caller that receives should_provision=true owns the external provision.
-- Other callers observe the persisted `provisioning` row and wait for it,
-- rather than creating another Daytona box.

create or replace function claim_runtime_computer(
  requested_project_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1'
)
returns table (
  runtime_computer_id uuid,
  should_provision boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Confirm both existence and ownership before acquiring a project-scoped
  -- lock. This keeps the RPC subject to the same access boundary as direct
  -- table reads under RLS.
  perform 1
  from projects
  where id = requested_project_id
    and owner_id = auth.uid();
  if not found then
    raise exception 'project not found';
  end if;

  perform pg_advisory_xact_lock(hashtext(requested_project_id::text));

  select * into existing
  from runtime_computers
  where project_id = requested_project_id;

  if found then
    -- A failed/stopped computer is retried in-place. Keeping the same row
    -- preserves the one-computer-per-project identity and avoids a duplicate
    -- external provision during concurrent retries.
    if existing.status in ('error', 'stopped') then
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
    end if;

    return query select existing.id, false;
    return;
  end if;

  insert into runtime_computers (
    owner_id,
    project_id,
    agent_secret,
    image_version,
    status
  ) values (
    auth.uid(),
    requested_project_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;
