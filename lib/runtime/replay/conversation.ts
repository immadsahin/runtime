/**
 * Replay-side conversation parser: raw Claude session JSONL → AgentEvent[].
 *
 * The live Timeline is fed by the agent, which derives events from the JSONL
 * on-box (runtime-agent/internal/conversation). Replay has NO agent and NO box
 * (M4 invariant #2: Replay is browser + storage only), so the same conversion
 * has to run off-box at read time. This is the faithful TS port of the Go
 * `decode`; the two are pinned together by a shared golden fixture
 * (`conversation.fixtures.json`, asserted from both languages) so they cannot
 * silently drift.
 *
 * Like the Go side it is DEFENSIVE: the JSONL is Claude's internal, undocumented
 * log, so it whitelists the record types it renders (user/assistant messages)
 * and tolerates everything else (app-internal types, unparseable lines).
 */
import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";

/** String content-block fields the Go struct marshals with `omitempty`. */
const STRING_KEYS = ["text", "id", "name", "toolUseId"] as const;
/** Raw-JSON content-block fields (json.RawMessage on the Go side). */
const RAW_KEYS = ["input", "content"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Project a raw content block onto the protocol keys, reproducing the Go struct's
 * marshaling exactly so replay is byte-equivalent to the live decoder:
 *  - string fields (text/id/name/toolUseId) are `omitempty` — dropped when empty;
 *  - `input`/`content` are json.RawMessage — kept whenever the key is PRESENT
 *    (including an explicit `null` or empty string), dropped only when absent.
 */
function cleanBlock(raw: Record<string, unknown>): ContentBlock {
  const out: Record<string, unknown> = {};
  if (typeof raw.type === "string") out.type = raw.type;
  for (const key of STRING_KEYS) {
    if (typeof raw[key] === "string" && raw[key] !== "") out[key] = raw[key];
  }
  for (const key of RAW_KEYS) {
    if (key in raw) out[key] = raw[key];
  }
  return out as ContentBlock;
}

/**
 * Parse the whole conversation JSONL into ordered message events. Lines are kept
 * in file order (the Timeline's source of truth); non-message records and
 * malformed lines are skipped. Every field is runtime-checked as `unknown` — a
 * single malformed record must never throw and fail the whole Replay.
 */
export function parseConversation(jsonl: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const event = decodeLine(line);
    if (event) events.push(event);
  }
  return events;
}

function decodeLine(line: string): AgentEvent | null {
  if (line.trim() === "") return null;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null; // tolerate unparseable lines
  }
  if (!isObject(rec)) return null;
  if (rec.type !== "user" && rec.type !== "assistant") return null; // whitelist
  const message = rec.message;
  if (!isObject(message)) return null;

  // Go decodes message.content into []ContentBlock; a non-array or a non-object
  // element fails that decode and the whole record is skipped — mirror it rather
  // than mapping over a non-array (which would throw).
  const rawContent = message.content;
  if (!Array.isArray(rawContent) || !rawContent.every(isObject)) return null;

  return {
    t: "message",
    uuid: typeof rec.uuid === "string" ? rec.uuid : "",
    parentUuid: typeof rec.parentUuid === "string" ? rec.parentUuid : null,
    // Pass the role through as the agent does — never silently relabel an
    // unexpected role as "assistant".
    role: (typeof message.role === "string" ? message.role : "") as "user" | "assistant",
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
    content: rawContent.map(cleanBlock),
  };
}
