import { ClaudeConnection } from "@/components/claude-connection";

export const dynamic = "force-dynamic";

/** Claude settings: connect the user's own Claude subscription (desktop app). */
export default function ClaudeSettings() {
  return <ClaudeConnection />;
}
