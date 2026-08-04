import { optionalEnv } from "@/lib/env";
import type { ExecuteJobInput, JobAgent } from "@/lib/runtime/types";

const AGENT_NAMES: Record<JobAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const AGENT_ENV_KEYS: Record<JobAgent, readonly ("ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN" | "CODEX_API_KEY")[]> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["CODEX_API_KEY"],
};

export function isJobAgent(value: unknown): value is JobAgent {
  return value === "claude" || value === "codex";
}

export function agentName(agent: JobAgent): string {
  return AGENT_NAMES[agent];
}

/** Server-only credential set injected into one selected agent invocation. */
export function agentJobEnvironment(agent: JobAgent): Record<string, string> {
  return Object.fromEntries(
    AGENT_ENV_KEYS[agent].flatMap((key) => {
      const value = optionalEnv(key);
      return value ? [[key, value]] : [];
    }),
  );
}

/** Credential values that must not reach the browser-visible job log. */
export function agentJobSecrets(agent: JobAgent): string[] {
  return Object.values(agentJobEnvironment(agent));
}

export function agentCredentialMessage(agent: JobAgent): string {
  return agent === "claude"
    ? "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to run Claude Code."
    : "Set CODEX_API_KEY to run Codex.";
}

/** Build a non-interactive command for the selected coding agent. */
export function agentCommand(
  agent: JobAgent,
  input: Pick<ExecuteJobInput, "prompt" | "resumeSessionId">,
): string {
  if (agent === "codex") {
    return [
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      shellQuote(input.prompt),
    ].join(" ");
  }

  const args = [
    "claude",
    "-p",
    shellQuote(input.prompt),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    shellQuote("Read,Edit,Write,Bash,Glob,Grep"),
  ];
  if (input.resumeSessionId) args.push("--resume", shellQuote(input.resumeSessionId));
  return args.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
