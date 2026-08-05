-- Milestone 4 — Archive / Replay / Restore state machine.
--
-- Archive is the action that produces a durable Workspace Snapshot; Restore
-- revives an archived Session from one. Both need explicit in-progress states so
-- concurrent lifecycle actions across tabs stay mutually exclusive while agent +
-- storage work is in flight (same rationale as suspending/destroying).
--
--   ready/idle --archive--> archiving --> archived
--   archived   --restore--> restoring --> ready
--
-- `restoring` is added now (one enum migration) though the Restore flow lands in
-- a later slice; it is unused until then.

alter type workspace_status add value if not exists 'archiving';
alter type workspace_status add value if not exists 'archived';
alter type workspace_status add value if not exists 'restoring';
