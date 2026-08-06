/**
 * M4 real-box acceptance verifier. It exercises the production boundaries that
 * hermetic tests intentionally cannot prove:
 *
 *   Daytona source box → runtime-agent archive → signed Supabase uploads
 *   → source box destroyed → signed downloads → fresh Daytona box restore
 *   → restored committed + uncommitted WIP → second restore (idempotency)
 *
 * This script does not call Next routes or write Runtime database rows: those
 * require an authenticated browser session. It is deliberately a narrow,
 * credential-gated verification of the provider/agent/storage data plane.
 * Run after applying the Snapshot migrations and building the Linux agent:
 *
 *   ./scripts/build-agent.sh
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs \
 *     --env-file=.env.local scripts/verify-daytona-m4.ts
 *
 * Required environment:
 *   DAYTONA_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   and one of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.
 *
 * Optional: VERIFY_REPO (default octocat/Hello-World), VERIFY_BASE (default
 * master), GITHUB_PAT (private repositories), VERIFY_OWNER_ID (a UUID used
 * only as the private Storage path segment; defaults to a fixed test UUID).
 */
import { randomBytes, createHash } from "node:crypto";

import { Daytona } from "@daytonaio/sdk";
import { createClient } from "@supabase/supabase-js";

import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import {
  SNAPSHOT_ARTIFACTS,
  parseManifest,
  type SnapshotArtifact,
  type SnapshotManifest,
} from "@/lib/runtime/snapshot/manifest";
import {
  mintSnapshotDownloadUrl,
  mintSnapshotUpload,
  SNAPSHOT_BUCKET,
  type SnapshotStorage,
} from "@/lib/runtime/storage/snapshots";
import type { ProvisionStage } from "@/lib/runtime/types";

const REPO = process.env.VERIFY_REPO ?? "octocat/Hello-World";
const BASE = process.env.VERIFY_BASE ?? "master";
const OWNER_ID = process.env.VERIFY_OWNER_ID ?? "00000000-0000-4000-8000-000000000000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const claudeCredential: Record<string, string> | null = process.env.CLAUDE_CODE_OAUTH_TOKEN
  ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
  : process.env.ANTHROPIC_API_KEY
    ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
    : null;

const suffix = randomBytes(6).toString("hex");
const workspaceId = `verify-m4-${suffix}`;
const verificationLabel = `m4-${suffix}`;
const branch = `runtime/verify-m4-${suffix}`;
const archivedAt = new Date().toISOString();
const worktreePath = `/home/runtime/workspaces/${workspaceId}`;
const claudeProjectDir = `/home/runtime/.claude/projects/${worktreePath.replaceAll(/[/.]/g, "-")}`;
const committedFile = "m4-committed.txt";
const wipFile = "m4-wip.txt";
const committedContents = `committed-${suffix}`;
const wipContents = `uncommitted-${suffix}`;

type LiveComputer = { sandboxId: string; secret: string; agent: AgentClient };

async function main(): Promise<void> {
  requireEnv("DAYTONA_API_KEY");
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!claudeCredential) {
    throw new Error("Missing CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.");
  }
  assertUuid(OWNER_ID, "VERIFY_OWNER_ID");

  const provider = new DaytonaRuntimeProvider();
  const storage = createStorage();
  const artifacts: string[] = [];
  let source: LiveComputer | null = null;
  let restored: LiveComputer | null = null;

  try {
    console.log(`[1] Provision source Runtime Computer for ${REPO} …`);
    source = await provision(provider, "source");

    const sourceIdentity = identity("source");
    console.log("[2] Create and start a real Claude Workspace Session …");
    await source.agent.createWorkspace(
      { workspaceId, repoFullName: REPO, branch, baseBranch: BASE },
      sourceIdentity,
    );
    await source.agent.startWorkspace(sourceIdentity);

    console.log("[3] Add one committed change and one uncommitted change …");
    await executeOnSandbox(source.sandboxId, [
      `cd ${shellQuote(worktreePath)}`,
      "git config user.name 'Runtime M4 verifier'",
      "git config user.email 'runtime-m4-verifier@example.invalid'",
      `printf '%s\\n' ${shellQuote(committedContents)} > ${shellQuote(committedFile)}`,
      `git add ${shellQuote(committedFile)}`,
      "git commit -m 'Runtime M4 verification commit'",
      `printf '%s\\n' ${shellQuote(wipContents)} > ${shellQuote(wipFile)}`,
    ].join(" && "));

    console.log("[4] Prime Claude through the authenticated PTY …");
    await primeClaudeSession(source.agent, sourceIdentity);

    console.log("[5] Wait for Claude to create its resumable JSONL session …");
    await waitForClaudeSession(source.sandboxId);

    console.log("[6] Archive through the agent into signed Supabase URLs …");
    const { prefix, urls } = await mintSnapshotUpload(
      storage,
      OWNER_ID,
      workspaceId,
      archivedAt,
    );
    artifacts.push(...urls.map((url) => url.path));
    const manifest = await source.agent.archiveWorkspace(sourceIdentity, {
      archivedAt,
      uploads: urls.map(({ artifact, signedUrl }) => ({ artifact, url: signedUrl })),
    });
    assert(manifest.workspaceId === workspaceId, "archive returned the wrong workspace id");
    assert(manifest.sessionId, "archive did not capture a Claude session id");
    assert(manifest.archivedAt === archivedAt, "archive timestamp drifted from signed URL prefix");
    console.log(`      Snapshot manifest captured session ${manifest.sessionId}.`);

    console.log("[7] Destroy the source Runtime Computer before reading the Snapshot …");
    await provider.destroyComputer(source.sandboxId);
    source = null;

    console.log("[8] Verify manifest-addressed artifacts from Storage only …");
    await verifySnapshotArtifacts(storage, prefix, manifest);

    console.log("[9] Provision a fresh Runtime Computer and restore the Snapshot …");
    restored = await provision(provider, "restore");
    const restoredIdentity = identity("restore");
    const downloads = await restoreDownloads(storage, prefix);
    await restored.agent.restoreWorkspace(restoredIdentity, {
      branch,
      baseBranch: BASE,
      sessionId: manifest.sessionId,
      downloads,
    });
    await assertRestoredWip(restored.sandboxId);

    console.log("[10] Restore the same Snapshot again (idempotency) …");
    await restored.agent.restoreWorkspace(restoredIdentity, {
      branch,
      baseBranch: BASE,
      sessionId: manifest.sessionId,
      downloads: await restoreDownloads(storage, prefix),
    });
    await assertRestoredWip(restored.sandboxId);

    console.log("\n✅ M4 VERIFY PASSED — archive uploads were complete, replay inputs survived source-box destruction, and a fresh Runtime Computer restored exact committed + uncommitted WIP twice.");
  } finally {
    if (source) await provider.destroyComputer(source.sandboxId);
    if (restored) await provider.destroyComputer(restored.sandboxId);
    await cleanupTimedOutVerificationComputers();
    if (artifacts.length > 0) {
      const client = createClient(supabaseUrl!, supabaseServiceKey!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await client.storage.from(SNAPSHOT_BUCKET).remove(artifacts);
      if (error) console.error(`cleanup: could not remove verification artifacts: ${error.message}`);
    }
  }
}

async function provision(
  provider: DaytonaRuntimeProvider,
  label: string,
): Promise<LiveComputer> {
  const secret = randomBytes(32).toString("hex");
  const computer = await provider.provisionComputer({
    secret,
    labels: {
      "runtime.verifier": "m4",
      "runtime.verification-id": verificationLabel,
    },
    repoFullName: REPO,
    githubToken: process.env.GITHUB_PAT,
    sessionEnv: claudeCredential!,
    onStage: (stage: ProvisionStage, ms) =>
      console.log(`      ${label}:${stage.padEnd(15)} ${ms} ms`),
  });
  const target = await provider.agentTarget(computer.sandboxId, secret);
  return { sandboxId: computer.sandboxId, secret, agent: new AgentClient(target) };
}

/** `Daytona.create` can time out locally after the service accepted a request.
 * Discover only this run's random label and remove it, so a delayed create does
 * not consume the organization's computer limit or block the next verifier. */
async function cleanupTimedOutVerificationComputers(): Promise<void> {
  const daytona = new Daytona({
    apiKey: requireEnv("DAYTONA_API_KEY"),
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });
  try {
    for await (const sandbox of daytona.list({
      labels: { "runtime.verification-id": verificationLabel },
    })) {
      console.log(`cleanup: removing delayed verification computer ${sandbox.id}`);
      await daytona.delete(sandbox);
    }
  } catch (error) {
    console.error(
      `cleanup: could not remove delayed verification computer: ${(error as Error).message}`,
    );
  }
}

function identity(computerLabel: string): WorkspaceIdentity {
  return {
    workspaceId,
    projectId: "verify-m4-project",
    computerId: `verify-m4-${computerLabel}`,
    userId: OWNER_ID,
  };
}

function createStorage(): SnapshotStorage {
  const client = createClient(supabaseUrl!, supabaseServiceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = client.storage.from(SNAPSHOT_BUCKET);
  return {
    async createSignedUploadUrl(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) throw new Error(error?.message ?? `no upload URL for ${path}`);
      return data;
    },
    async createSignedDownloadUrl(path, expiresIn) {
      const { data, error } = await bucket.createSignedUrl(path, expiresIn);
      if (error || !data) throw new Error(error?.message ?? `no download URL for ${path}`);
      return data;
    },
  };
}

/** The verifier uses the Daytona SDK only to create test WIP and inspect the
 * restored filesystem. All lifecycle/archive/restore operations use AgentClient. */
async function executeOnSandbox(sandboxId: string, command: string): Promise<string> {
  const daytona = new Daytona({
    apiKey: requireEnv("DAYTONA_API_KEY"),
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });
  const sandbox = await daytona.get(sandboxId);
  const result = await sandbox.process.executeCommand(`bash -lc ${shellQuote(command)}`);
  if ((result.exitCode ?? 0) !== 0) {
    throw new Error(`sandbox command failed (${result.exitCode}): ${result.result ?? ""}`);
  }
  return result.result ?? "";
}

async function waitForClaudeSession(sandboxId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const session = await executeOnSandbox(
      sandboxId,
      `find ${shellQuote(claudeProjectDir)} -type f -name '*.jsonl' -size +0c -print -quit 2>/dev/null || true`,
    );
    if (session.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const status = await claudeStartupStatus(sandboxId);
  throw new Error(
    "Claude did not create a non-empty JSONL session within 120 seconds. " +
      `Startup status: ${status}`,
  );
}

/** Report only process/file-system facts on a transcript timeout. Terminal
 * contents can include customer code or account metadata, so deliberately do
 * not capture the tmux pane or Claude's own log output here. */
async function claudeStartupStatus(sandboxId: string): Promise<string> {
  const result = await executeOnSandbox(sandboxId, [
    "printf 'cli='; command -v claude || printf missing",
    `printf ';tmux='; tmux has-session -t ${shellQuote(`ws-${workspaceId}`)} 2>/dev/null && printf present || printf absent`,
    `printf ';jsonl='; find ${shellQuote(claudeProjectDir)} -type f -name '*.jsonl' -size +0c -print 2>/dev/null | wc -l`,
    "printf ';processes='; pgrep -fc '[c]laude' || true",
  ].join("; "));
  return result.trim().replaceAll(/\s+/g, " ");
}

/** Claude creates a resumable JSONL only after it receives a user turn. Drive
 * that turn over Runtime's authenticated PTY instead of reaching into tmux, so
 * the verifier proves the same browser transport a Workspace Session uses.
 *
 * A writer role only means the agent attached to tmux; immediately after Start,
 * Claude may still be rendering its initial screen. Waiting for the first
 * terminal output to settle avoids dropping the verifier's prompt into that
 * startup path (which can leave a real session without a conversation log). */
function primeClaudeSession(agent: AgentClient, identity: WorkspaceIdentity): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(agent.ptyUrl(identity));
    let sent = false;
    let settled = false;
    let writerAt = 0;
    let lastOutputAt = 0;
    let promptTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => done(new Error("timed out waiting for PTY writer role")), 20_000);

    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (promptTimer) clearTimeout(promptTimer);
      try {
        socket.close();
      } catch {
        // The socket may already be closed after the agent rejects a connection.
      }
      if (error) reject(error);
      else resolve();
    };

    const sendPrompt = () => {
      if (sent || !writerAt) return;
      sent = true;
      socket.send(JSON.stringify({ t: "resize", cols: 120, rows: 32 }));
      socket.send(JSON.stringify({
        t: "input",
        data: "Reply with exactly: Runtime M4 verifier ready.\r",
      }));
      // Keep the attach open long enough for tmux to deliver the frame. The
      // JSONL wait below, rather than this timing, proves Claude persisted it.
      promptTimer = setTimeout(() => done(), 2_000);
    };

    const schedulePrompt = () => {
      if (sent || !writerAt) return;
      if (promptTimer) clearTimeout(promptTimer);
      const now = Date.now();
      // Wait at least three seconds from writer assignment and one quiet second
      // after the latest output. Cap the wait at fifteen seconds so a spinner
      // cannot prevent the verifier from making its harmless user turn.
      const quietFor = lastOutputAt ? Math.max(0, 1_000 - (now - lastOutputAt)) : 0;
      const warmFor = Math.max(0, 3_000 - (now - writerAt));
      const forceFor = Math.max(0, 15_000 - (now - writerAt));
      promptTimer = setTimeout(sendPrompt, Math.min(Math.max(quietFor, warmFor), forceFor));
    };

    socket.addEventListener("message", (event: MessageEvent) => {
      let frame: { t?: string; writer?: boolean } | null = null;
      try {
        frame = JSON.parse(String(event.data)) as { t?: string; writer?: boolean };
      } catch {
        return;
      }
      if (frame.t === "output") {
        lastOutputAt = Date.now();
        schedulePrompt();
        return;
      }
      if (frame.t !== "role") return;
      if (!frame.writer) {
        done(new Error("PTY verifier connection was not elected writer"));
        return;
      }
      writerAt = Date.now();
      schedulePrompt();
    });
    socket.addEventListener("error", () => done(new Error("PTY connection failed")));
    socket.addEventListener("close", () => {
      if (!sent) done(new Error("PTY closed before a writer role was assigned"));
    });
  });
}

async function verifySnapshotArtifacts(
  storage: SnapshotStorage,
  prefix: string,
  expected: SnapshotManifest,
): Promise<void> {
  const manifestBytes = await download(storage, `${prefix}${SNAPSHOT_ARTIFACTS.manifest}`);
  const received = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  assert(
    JSON.stringify(received) === JSON.stringify(expected),
    "stored manifest differs from the archive response",
  );

  for (const artifact of payloadArtifacts()) {
    const filename = SNAPSHOT_ARTIFACTS[artifact];
    const bytes = await download(storage, `${prefix}${filename}`);
    assert(
      expected.sizes[filename] === bytes.byteLength,
      `${filename} size differs from its manifest entry`,
    );
    assert(
      expected.checksums[filename] === sha256(bytes),
      `${filename} checksum differs from its manifest entry`,
    );
  }
}

async function restoreDownloads(
  storage: SnapshotStorage,
  prefix: string,
): Promise<{ artifact: "bundle" | "patch" | "conversation"; url: string }[]> {
  return Promise.all(
    (["bundle", "patch", "conversation"] as const).map(async (artifact) => ({
      artifact,
      url: await mintSnapshotDownloadUrl(
        storage,
        `${prefix}${SNAPSHOT_ARTIFACTS[artifact]}`,
        OWNER_ID,
      ),
    })),
  );
}

async function download(storage: SnapshotStorage, path: string): Promise<Uint8Array> {
  const url = await mintSnapshotDownloadUrl(storage, path, OWNER_ID);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${path} failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function assertRestoredWip(sandboxId: string): Promise<void> {
  const output = await executeOnSandbox(sandboxId, [
    `cd ${shellQuote(worktreePath)}`,
    "test \"$(git branch --show-current)\" = " + shellQuote(branch),
    `test \"$(cat ${shellQuote(committedFile)})\" = ${shellQuote(committedContents)}`,
    `test \"$(cat ${shellQuote(wipFile)})\" = ${shellQuote(wipContents)}`,
    `git status --porcelain -- ${shellQuote(wipFile)} | grep -q ${shellQuote(`?? ${wipFile}`)}`,
    "git rev-parse --verify HEAD",
  ].join(" && "));
  console.log(`      restored HEAD: ${output.trim()}`);
}

function payloadArtifacts(): Exclude<SnapshotArtifact, "manifest">[] {
  return ["conversation", "cast", "bundle", "patch", "summary"];
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}. Put it in .env.local.`);
  return value;
}

function assertUuid(value: string, label: string): void {
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    `${label} must be a UUID`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

main().catch((error) => {
  console.error("\n❌ M4 VERIFY FAILED:", error);
  process.exitCode = 1;
});
