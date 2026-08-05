# M4 Spike — PTY cast capture (asciinema v2)

**Date:** 2026-08-05 · **Scope:** M4 foundation (parallel-safe with M3) · **Verdict: ✅ recorder landed; tmux fidelity test written, pending a tmux box**

Proves the agent can record a workspace's terminal as an **asciinema v2** cast,
server-side and **from session start, independent of any browser connection**
(M4 invariant #3), so a Snapshot replays with no Runtime Computer.

## Approach (matches the frozen decisions)

- **Capture primitive: `tmux pipe-pane`, not a tee of the browser PTY.** The
  browser PTY (`ptyx`) only exists while a client is attached, so tee-ing it
  would violate invariant #3. `pipe-pane -O` streams the pane's output
  continuously, independent of any client — the correct primitive — and needs
  **zero** change to `ptyx/session.go`.
- **Timing: `pipe-pane` → FIFO → framer.** `pipe-pane` carries bytes but no
  timing, so `cat >> <fifo>` feeds a Go goroutine that stamps each chunk with
  elapsed time and frames it as v2. A **pure framer** (`cast/framer.go`) is split
  from the I/O so timing is deterministic under test via an injected clock.
- **Terminal safety first.** If writing the cast ever fails, the recorder
  **detaches the pipe and discard-drains** rather than back-pressuring the FIFO —
  the live terminal must never freeze because recording stalled.
- **Coalescing + buffering.** A `bufio` writer coalesces sub-`5ms` bursts into
  one frame, cutting frame count and write syscalls with no perceptible replay
  difference. Flush-on-Close captures the tail.

## Key finding — draining the FIFO portably

The obvious "block on read, unblock via `Close()`" and "`SetReadDeadline`"
approaches **both fail on macOS/BSD**: closing an fd doesn't reliably interrupt a
blocked `Read`, and FIFOs report *"file type does not support deadline."* The
recorder therefore opens the read end **`O_RDWR | O_NONBLOCK`** (a permanent
writer end ⇒ no spurious EOF between bursts; non-blocking ⇒ interruptible) and
runs a **read + sleep-on-`EAGAIN`** loop. Active output is read as fast as it
arrives (no distortion); only idle gaps poll (`20ms`). `Stop` sets a flag; the
loop drains the buffered tail (reads until `EAGAIN`) and exits.

## What landed

- `runtime-agent/internal/cast/`: `framer.go` (pure v2 framer + injected clock),
  `recorder.go` (FIFO lifecycle, non-blocking drain, disarm-on-error, idempotent
  Start/Stop), `tmux_pane.go` (the `pipe-pane` pane impl), `cast.go`
  (`DefaultCastName = "session.cast"` — the one artifact name the Go side needs;
  the storage path scheme is Next's, since Next mints upload URLs).
- Tests: framer unit tests (header, coalescing, monotonic timing) and a
  fake-pane recorder test (drain → frame → file, disarm, idempotency) run in
  `go test`; a **tmux-gated** end-to-end fidelity test
  (`TestRecorderTmuxFidelity`) records a real pane on a private tmux socket and
  asserts the scripted output round-trips — it **skips where tmux is absent**.

**Acceptance status:** unit + fake-pane paths verified here (`go test ./...`
green). The real-tmux fidelity test is written and isolated; run it on a box
with tmux (e.g. the Daytona runtime image) to close the acceptance criterion.

## Integration — deferred, flagged for M3

The recorder owns its own lifecycle; wiring it to a Session is **one call each**
in `workspace/service.go`:

- `Start` (after `tmux.NewSession`): construct `cast.NewSessionRecorder(name,
  worktree, cast.Options{})` and `recorder.Start(ctx)` — recording begins at
  session start.
- `Stop`/`Archive` (before `KillSession`): `recorder.Stop(ctx)` to finalize the
  cast.

This is **intentionally not landed** — `workspace/service.go` is M3 territory and
the archive/upload flow that consumes the cast is M3-blocked. Flagging it here so
the M3 agent adds the two calls (and threads the recorder handle onto the
Session) without surprise at merge. Nothing in this foundation changes existing
behavior until those calls are added.

## Pointers
- Frozen M4 design: [`m4-plan.md`](./m4-plan.md)
- Foundations scope/contract: [`m4-foundations-handoff.md`](./m4-foundations-handoff.md)
