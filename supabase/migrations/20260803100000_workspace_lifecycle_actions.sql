-- M5 lifecycle controls need explicit in-progress states. They make suspend
-- and destroy mutually exclusive across multiple browser tabs while provider
-- calls are in flight.

alter type workspace_status add value if not exists 'suspending';
alter type workspace_status add value if not exists 'destroying';
