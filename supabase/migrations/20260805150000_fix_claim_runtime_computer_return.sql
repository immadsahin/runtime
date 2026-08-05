-- Ensure every claim branch returns exactly one row to PostgREST.
--
-- `claim_runtime_computer` is the concurrency gate for lazy provisioning.
-- An error/stopped retry must both reset the durable row and return ownership
-- to the caller. Use explicit OUT-parameter assignment + RETURN NEXT rather
-- than RETURN QUERY so the RPC response shape is unambiguous.

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
    runtime_computer_id := existing.id;

    if existing.status in ('error', 'stopped') then
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;

      should_provision := true;
    else
      should_provision := false;
    end if;

    return next;
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
  ) returning id into runtime_computer_id;

  should_provision := true;
  return next;
  return;
end;
$$;
