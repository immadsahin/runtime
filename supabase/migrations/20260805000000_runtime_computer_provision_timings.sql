-- Phase 1 · Milestone 2 pt2 — instrument provisioning from day one.
--
-- The pt2 provisioning spike measured a real box: sandbox create ~4s, agent
-- upload ~38s (the bottleneck, since mitigated with gzip), boot ~1s. To keep
-- that visibility in production, every Runtime Computer records the wall-clock
-- breakdown of its last provision here. When someone reports "workspace creation
-- feels slow", the regressed stage is a lookup, not a guess.
--
-- Shape (domain ProvisionTimings):
--   { "stages": [ { "stage": "sandbox_create", "ms": 4063 }, ... ],
--     "totalMs": 43120 }
-- ---------------------------------------------------------------------------

alter table runtime_computers
  add column provision_timings jsonb;
