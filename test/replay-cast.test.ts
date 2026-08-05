import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCast } from "@/lib/runtime/replay/cast";

test("parseCast reads the header and output frames, in order", () => {
  const cast = [
    '{"version":2,"width":120,"height":40,"timestamp":1730000000}',
    '[0.1,"o","hello "]',
    '[0.5,"o","world"]',
    '[1.25,"o","!\\r\\n"]',
  ].join("\n");

  const { header, frames, duration } = parseCast(cast);
  assert.deepEqual(header, { version: 2, width: 120, height: 40, timestamp: 1730000000 });
  assert.deepEqual(frames, [
    { time: 0.1, data: "hello " },
    { time: 0.5, data: "world" },
    { time: 1.25, data: "!\r\n" },
  ]);
  assert.equal(duration, 1.25);
});

test("parseCast tolerates malformed lines and skips non-output events", () => {
  const cast = [
    '{"version":2,"width":80,"height":24}',
    "not json",
    '[0.2,"i","typed input"]',
    "",
    '[0.3,"o","shown"]',
    '[0.4,"o"]',
  ].join("\n");

  const { frames, duration } = parseCast(cast);
  assert.deepEqual(frames, [{ time: 0.3, data: "shown" }]);
  assert.equal(duration, 0.3);
});

test("parseCast falls back to defaults for an empty or headerless cast", () => {
  assert.deepEqual(parseCast("").frames, []);
  assert.equal(parseCast("").duration, 0);
  assert.deepEqual(parseCast("").header, { version: 2, width: 80, height: 24 });

  // Negative frame times are clamped to zero.
  const { frames } = parseCast('{"version":2,"width":80,"height":24}\n[-1,"o","x"]');
  assert.deepEqual(frames, [{ time: 0, data: "x" }]);
});
