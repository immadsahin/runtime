/**
 * Replay-side asciinema v2 parser. The agent records the terminal as a v2 cast
 * (runtime-agent/internal/cast): a header object line followed by
 * `[elapsed, "o", data]` output-event lines. Replay reads the stored cast
 * straight from storage (no box) and plays it back into an xterm terminal.
 *
 * Pure and defensive: a malformed frame is skipped rather than aborting the
 * whole playback.
 */

export type CastHeader = {
  version: number;
  width: number;
  height: number;
  timestamp?: number;
};

/** One output event: `time` seconds since session start, `data` to write. */
export type CastFrame = { time: number; data: string };

export type Cast = {
  header: CastHeader;
  frames: CastFrame[];
  /** Wall-clock length of the recording, in seconds (last frame time, or 0). */
  duration: number;
};

const DEFAULT_HEADER: CastHeader = { version: 2, width: 80, height: 24 };

export function parseCast(text: string): Cast {
  const lines = text.split("\n");
  let header: CastHeader = DEFAULT_HEADER;
  const frames: CastFrame[] = [];
  let headerParsed = false;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate a malformed line
    }

    if (!headerParsed) {
      // The first well-formed line is the header object.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const h = parsed as Partial<CastHeader>;
        header = {
          version: typeof h.version === "number" ? h.version : 2,
          width: typeof h.width === "number" && h.width > 0 ? h.width : 80,
          height: typeof h.height === "number" && h.height > 0 ? h.height : 24,
          timestamp: typeof h.timestamp === "number" ? h.timestamp : undefined,
        };
        headerParsed = true;
        continue;
      }
      // No header object present; fall through and treat as headerless frames.
      headerParsed = true;
    }

    // Event line: [time, code, data]. Only "o" (output) is played back.
    if (
      Array.isArray(parsed) &&
      parsed.length >= 3 &&
      typeof parsed[0] === "number" &&
      parsed[1] === "o" &&
      typeof parsed[2] === "string"
    ) {
      frames.push({ time: Math.max(0, parsed[0]), data: parsed[2] });
    }
  }

  const duration = frames.length ? frames[frames.length - 1].time : 0;
  return { header, frames, duration };
}
