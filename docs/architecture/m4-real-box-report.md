# M4 Real-Box Verification Report

## Attempt — 2026-08-06

### Purpose

Run the credential-gated `pnpm verify:daytona:m4` data-plane acceptance path:

1. provision a source Daytona Runtime Computer;
2. create a real Claude Workspace Session and committed + uncommitted WIP;
3. archive through the runtime-agent to signed Supabase URLs;
4. destroy source compute, verify the manifest-addressed Storage objects;
5. restore on a fresh Daytona Runtime Computer and restore again for idempotency.

This narrow verifier does **not** replace the authenticated Next/browser
acceptance for lifecycle state, Timeline, Replay UI, or Publish.

### Evidence collected

The supplied Daytona credential authenticated successfully. Source-computer
provisions reached every M2 control-plane stage:

| Stage | First observed run |
| --- | ---: |
| sandbox create | 762 ms |
| runtime-agent upload | 460 ms |
| agent boot | 296 ms |
| agent health check | 145 ms |
| bare mirror clone | 419 ms |

Two live runs also created a workspace, started its Claude tmux session, and
wrote the verifier's committed and uncommitted WIP successfully. Both then
failed before archive because Claude had not produced a non-empty project JSONL
within the verifier timeout (90 seconds, then 120 seconds after the retry).
No Snapshot artifact was uploaded and no restore assertion was claimed.

### Verifier defects found and corrected

- The default test-only `VERIFY_OWNER_ID` did not satisfy the verifier's own
  UUID validation rule. It is now a valid UUIDv4-shaped fixed value.
- The script's nested shell escaping for Daytona's direct command helper was
  malformed; it now matches the shared Daytona deploy escaping.
- Starting Claude with no user turn did not guarantee a JSONL transcript. The
  verifier now sends a harmless deterministic prompt through the authenticated
  Runtime PTY, then waits for the real Claude transcript before archiving.
- The first PTY prompt could be submitted while Claude was still rendering its
  startup UI. The verifier now waits for initial terminal output to settle
  before writing, while retaining a bounded fallback for an animated startup.
  It also reports only non-sensitive CLI/tmux/process/file facts on a transcript
  timeout; it intentionally does not capture terminal panes or Claude logs.
- A client-side Daytona create timeout can leave a delayed request behind. M4
  attempts now have a random provider label and clean up only their own labelled
  delayed computers.

### Current external blocker

After Daytona capacity was reported available, a subsequent fresh source-box
attempt did not receive a capacity rejection but did not finish creation either:

> `DaytonaTimeoutError: Failed to create and start sandbox within 180 seconds.`

The verifier-owned computer
`b2bace34-d305-4a00-9755-3f6a07bff5b7` remains in Daytona's `creating` state,
with no state timestamp change after the create timeout. A safe delete request
was rejected by Daytona with `Sandbox state change in progress`. Its provider
labels unambiguously identify it as the M4 verification run, but no local
control-plane operation can cancel the in-progress Daytona lifecycle change.

This distinguishes the current problem from a cost or product-plan question:
Runtime successfully authenticated and provisioned real boxes earlier in the
same session, but the provider's lifecycle API is now stuck before a fresh box
is usable. The prior real sessions also exposed an independent unresolved
Claude transcript-production gate.

**M4 real-box acceptance remains pending.** Release sufficient Daytona
organization capacity if needed, and have Daytona complete or clear the
verifier-owned stuck `creating` computer. Then rerun:

```sh
./scripts/build-agent.sh
pnpm verify:daytona:m4
```

On a future timeout, the run-specific label permits the verifier to remove only
its own delayed computer safely once Daytona accepts lifecycle changes.
