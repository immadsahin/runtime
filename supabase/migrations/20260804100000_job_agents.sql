-- Each durable job records which coding agent executed it. Existing M6 jobs
-- are Claude jobs, preserving historical status, log, and session behavior.

alter table jobs
  add column if not exists agent text not null default 'claude';

alter table jobs
  drop constraint if exists jobs_agent_check;

alter table jobs
  add constraint jobs_agent_check check (agent in ('claude', 'codex'));
