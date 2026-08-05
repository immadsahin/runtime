"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { Cast } from "@/lib/runtime/replay/cast";

export type CastPlayerStatus = "empty" | "paused" | "playing" | "ended";

export type CastPlayer = {
  status: CastPlayerStatus;
  /** Current playhead position, in seconds. */
  currentTime: number;
  duration: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Jump the playhead to `t` seconds, reconstructing terminal state there. */
  seek: (t: number) => void;
};

/**
 * Plays an asciinema cast into an xterm terminal it owns. Playback is driven by
 * a self-scheduling timer anchored to wall-clock time, so frame timing survives
 * a slow paint. Because terminal state is cumulative, seeking replays from the
 * start up to the target time (a reset + fast-forward) — correct for backward
 * and forward jumps alike.
 *
 * No box, no WebSocket: everything comes from the parsed cast (M4 invariant #2).
 */
export function useCastPlayer(
  cast: Cast | null,
  containerRef: RefObject<HTMLDivElement | null>,
): CastPlayer {
  const termRef = useRef<Terminal | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameIndexRef = useRef(0);
  // Playback anchor: the wall-clock ms and the cast time at the last play/seek.
  const anchorWallRef = useRef(0);
  const anchorCastRef = useRef(0);
  const currentTimeRef = useRef(0);

  const [status, setStatus] = useState<CastPlayerStatus>("empty");
  const [currentTime, setCurrentTime] = useState(0);
  const duration = cast?.duration ?? 0;

  const setTime = useCallback((t: number) => {
    currentTimeRef.current = t;
    setCurrentTime(t);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Mount the xterm instance, sized to the recording's own dimensions so the
  // captured output wraps exactly as it did live. Recreated if the cast changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      theme: { background: "#0b0b0b" },
      cols: cast?.header.width ?? 80,
      rows: cast?.header.height ?? 24,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;

    setStatus(cast && cast.frames.length ? "paused" : "empty");
    setTime(0);
    frameIndexRef.current = 0;

    return () => {
      clearTimer();
      term.dispose();
      termRef.current = null;
    };
  }, [cast, containerRef, clearTimer, setTime]);

  // Write every frame with time <= t after a reset — reconstructs the exact
  // terminal state at `t`, and leaves frameIndexRef at the first later frame.
  const renderUpTo = useCallback(
    (t: number) => {
      const term = termRef.current;
      const frames = cast?.frames ?? [];
      if (!term) return;
      term.reset();
      let i = 0;
      while (i < frames.length && frames[i].time <= t) {
        term.write(frames[i].data);
        i += 1;
      }
      frameIndexRef.current = i;
    },
    [cast],
  );

  // The self-scheduling playback step. Kept in a ref so setTimeout always calls
  // the latest closure (fresh cast/duration) without re-arming timers, and the
  // ref is updated from an effect — never during render.
  const tickRef = useRef<() => void>(() => {});

  const tick = useCallback(() => {
    const term = termRef.current;
    const frames = cast?.frames ?? [];
    if (!term) return;

    const elapsed =
      anchorCastRef.current + (Date.now() - anchorWallRef.current) / 1000;

    let i = frameIndexRef.current;
    while (i < frames.length && frames[i].time <= elapsed) {
      term.write(frames[i].data);
      i += 1;
    }
    frameIndexRef.current = i;

    if (i >= frames.length) {
      setTime(duration);
      setStatus("ended");
      clearTimer();
      return;
    }
    setTime(Math.min(elapsed, duration));
    const wait = Math.max(0, (frames[i].time - elapsed) * 1000);
    timerRef.current = setTimeout(() => tickRef.current(), wait);
  }, [cast, duration, clearTimer, setTime]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const play = useCallback(() => {
    if (!cast || !cast.frames.length || !termRef.current) return;
    // Restart from the top once the cast has fully played out.
    if (currentTimeRef.current >= duration) {
      renderUpTo(0);
      setTime(0);
    }
    anchorWallRef.current = Date.now();
    anchorCastRef.current = currentTimeRef.current;
    setStatus("playing");
    tickRef.current();
  }, [cast, duration, renderUpTo, setTime]);

  const pause = useCallback(() => {
    clearTimer();
    const elapsed = Math.min(
      duration,
      anchorCastRef.current + (Date.now() - anchorWallRef.current) / 1000,
    );
    setTime(elapsed);
    setStatus((s) => (s === "playing" ? "paused" : s));
  }, [clearTimer, duration, setTime]);

  const seek = useCallback(
    (t: number) => {
      if (!cast) return;
      const clamped = Math.max(0, Math.min(t, duration));
      clearTimer();
      renderUpTo(clamped);
      setTime(clamped);
      if (status === "playing") {
        anchorWallRef.current = Date.now();
        anchorCastRef.current = clamped;
        tickRef.current();
      } else {
        setStatus(clamped >= duration && duration > 0 ? "ended" : "paused");
      }
    },
    [cast, duration, clearTimer, renderUpTo, status, setTime],
  );

  const toggle = useCallback(() => {
    if (status === "playing") pause();
    else play();
  }, [status, play, pause]);

  return { status, currentTime, duration, play, pause, toggle, seek };
}
