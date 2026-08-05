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

/** The content-block keys the protocol carries (mirrors protocol.ContentBlock). */
const BLOCK_KEYS = [
  "type",
  "text",
  "id",
  "name",
  "input",
  "toolUseId",
  "content",
] as const;

type RawRecord = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown[] } | null;
};

/**
 * Project a raw content block onto just the protocol keys, matching the Go
 * struct's `omitempty` marshaling (empty strings / absent values are dropped),
 * so the off-box parse reproduces the exact events the agent would have emitted.
 */
function cleanBlock(raw: unknown): ContentBlock {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    const src = raw as Record<string, unknown>;
    for (const key of BLOCK_KEYS) {
      const value = src[key];
      if (value !== undefined && value !== null && value !== "") {
        out[key] = value;
      }
    }
  }
  return out as ContentBlock;
}

/**
 * Parse the whole conversation JSONL into ordered message events. Lines are kept
 * in file order (the Timeline's source of truth); non-message records and
 * malformed lines are skipped.
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
  let rec: RawRecord;
  try {
    rec = JSON.parse(line) as RawRecord;
  } catch {
    return null; // tolerate unparseable lines
  }
  if (rec.type !== "user" && rec.type !== "assistant") return null;
  if (!rec.message) return null;
  return {
    t: "message",
    uuid: rec.uuid ?? "",
    parentUuid: rec.parentUuid ?? null,
    role: rec.message.role === "user" ? "user" : "assistant",
    timestamp: rec.timestamp ?? "",
    content: (rec.message.content ?? []).map(cleanBlock),
  };
}
