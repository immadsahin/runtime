"use client";

import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Layers3,
  LoaderCircle,
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  Send,
  TerminalSquare,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { WorkspaceChanges } from "@/components/workspace-changes";
import { WorkspaceLifecycleControls } from "@/components/workspace-lifecycle-controls";
import { WorkspacePublishPanel } from "@/components/workspace-publish-panel";
import type { Job, Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type SideTab = "diff" | "terminal" | "publish";

export function WorkspaceStudio({
  project,
  workspace,
  workspaces,
  jobs,
  pullRequest,
}: {
  project: Project;
  workspace: Workspace;
  workspaces: Workspace[];
  jobs: Job[];
  pullRequest: WorkspacePullRequest | null;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SideTab>("diff");
  const [rightOpen, setRightOpen] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const activeJob = jobs.find((job) => job.status === "queued" || job.status === "running");

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const task = prompt.trim();
    if (!task || submitting || !isReady || activeJob) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: task }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(result.error ?? "Could not start this run. Please try again.");
        return;
      }
      setPrompt("");
      router.refresh();
    } catch {
      setError("Could not reach Runtime. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="studio-shell">
      <aside className="studio-rail" aria-label="Primary navigation">
        <Link className="studio-mark" href="/" aria-label="Runtime projects">
          <TerminalSquare />
        </Link>
        <div className="studio-rail-nav">
          <Link href="/" title="Projects"><Layers3 /></Link>
          <Link href="/workspaces" className="is-active" title="Workspaces"><GitBranch /></Link>
          <Link href={`/projects/${project.id}`} title="Project"><CircleDot /></Link>
        </div>
        <div className="studio-avatar" aria-label="Account">R</div>
      </aside>

      <aside className="studio-sidebar">
        <div className="studio-project-head">
          <Link href={`/projects/${project.id}`} className="studio-back"><ArrowLeft /> Projects</Link>
          <p className="studio-eyebrow">PROJECT</p>
          <h1 title={project.fullName}>{project.fullName}</h1>
          <span><GitBranch /> {project.defaultBranch}</span>
        </div>
        <Link href={`/projects/${project.id}`} className="studio-new-thread">
          <Plus /> New workspace
        </Link>
        <div className="studio-thread-label"><span>WORKSPACES</span><span>{workspaces.length}</span></div>
        <nav className="studio-thread-list" aria-label="Project workspaces">
          {workspaces.map((item) => {
            const selected = item.id === workspace.id;
            return (
              <Link
                key={item.id}
                href={`/workspaces/${item.id}`}
                className={cn("studio-thread", selected && "is-selected")}
              >
                <span className={cn("studio-status", `is-${item.status}`)} />
                <span className="studio-thread-copy">
                  <strong>{item.branch}</strong>
                  <small>{item.status === "ready" ? "ready" : item.status} · worktree</small>
                </span>
                {selected && <ChevronDown className="studio-thread-chevron" />}
              </Link>
            );
          })}
        </nav>
        <div className="studio-sidebar-foot">
          <span>isolated from</span><code>{workspace.baseBranch}</code>
        </div>
      </aside>

      <section className="studio-chat">
        <header className="studio-chat-header">
          <div className="studio-title">
            <span className={cn("studio-status", `is-${workspace.status}`)} />
            <div>
              <h2>{workspace.branch}</h2>
              <p>{workspace.provider} worktree · {workspace.status}</p>
            </div>
          </div>
          <div className="studio-header-actions">
            {workspace.status === "ready" && <span className="studio-ready"><CheckCircle2 /> Ready</span>}
            <button className="studio-icon-button" title="New thread"><MessageSquarePlus /></button>
            <button className="studio-icon-button" onClick={() => setRightOpen((open) => !open)} title="Toggle inspector">
              {rightOpen ? <PanelRightClose /> : <FileDiff />}
            </button>
          </div>
        </header>

        <div className="studio-conversation">
          <div className="studio-run-notice">
            <span><TerminalSquare /> WORKSPACE</span>
            <p>Every thread runs in this isolated worktree. Changes remain on <code>{workspace.branch}</code> until you publish a pull request.</p>
          </div>

          {jobs.length === 0 ? (
            <div className="studio-empty-chat">
              <div className="studio-empty-icon"><MessageSquarePlus /></div>
              <h3>Start working in this workspace</h3>
              <p>Describe what you want changed. Runtime will run the task against this worktree, not <code>{workspace.baseBranch}</code>.</p>
              <div className="studio-prompt-chips">
                <button onClick={() => setPrompt("Inspect this repository and explain the safest next change.")}>Inspect the repo</button>
                <button onClick={() => setPrompt("Review the current changes and suggest what to do next.")}>Review changes</button>
              </div>
            </div>
          ) : (
            <div className="studio-messages">
              {jobs.map((job) => <JobMessage key={job.id} job={job} />)}
            </div>
          )}
        </div>

        <form className="studio-composer" onSubmit={sendMessage}>
          <textarea
            aria-label="Message for Runtime"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={isReady ? "Ask Runtime to work in this workspace…" : "This workspace must be ready before work can start."}
            disabled={!isReady || Boolean(activeJob) || submitting}
            rows={3}
          />
          <div className="studio-composer-footer">
            <span><TerminalSquare /> {activeJob ? "Run in progress" : "Runtime agent"}</span>
            <button type="submit" disabled={!prompt.trim() || !isReady || Boolean(activeJob) || submitting}>
              {submitting ? <LoaderCircle className="animate-spin" /> : <><Send /> Send</>}
            </button>
          </div>
          {error && <p className="studio-form-error" aria-live="polite">{error}</p>}
        </form>
      </section>

      {rightOpen && (
        <aside className="studio-inspector">
          <div className="studio-inspector-tabs" role="tablist" aria-label="Workspace details">
            <InspectorTab active={activeTab === "diff"} onClick={() => setActiveTab("diff")} icon={<FileDiff />} label="Changes" />
            <InspectorTab active={activeTab === "terminal"} onClick={() => setActiveTab("terminal")} icon={<TerminalSquare />} label="Terminal" />
            <InspectorTab active={activeTab === "publish"} onClick={() => setActiveTab("publish")} icon={<GitPullRequest />} label="Publish" />
            <button className="studio-close-inspector" onClick={() => setRightOpen(false)} title="Close inspector"><X /></button>
          </div>
          <div className="studio-inspector-content">
            {activeTab === "diff" && <>
              <div className="studio-inspector-heading"><div><p>Worktree changes</p><span>Compared with {workspace.baseBranch}</span></div><GitBranch /></div>
              <WorkspaceChanges workspaceId={workspace.id} active={isReady} />
            </>}
            {activeTab === "terminal" && <TerminalPanel workspace={workspace} activeJob={activeJob} />}
            {activeTab === "publish" && <>
              <div className="studio-inspector-heading"><div><p>Pull request</p><span>Publish this workspace when it is ready.</span></div><GitPullRequest /></div>
              <WorkspacePublishPanel workspaceId={workspace.id} branch={workspace.branch} baseBranch={workspace.baseBranch} pullRequest={pullRequest} active={isReady} />
              <div className="studio-compute-actions">
                <div className="studio-inspector-heading"><div><p>Workspace controls</p><span>Pause or remove this isolated worktree.</span></div></div>
                <WorkspaceLifecycleControls workspaceId={workspace.id} status={workspace.status} />
              </div>
            </>}
          </div>
        </aside>
      )}
    </div>
  );
}

function InspectorTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button role="tab" aria-selected={active} className={cn("studio-inspector-tab", active && "is-active")} onClick={onClick}>{icon}{label}</button>;
}

function JobMessage({ job }: { job: Job }) {
  const running = job.status === "running" || job.status === "queued";
  return <article className="studio-message">
    <div className="studio-user-message">{job.prompt}</div>
    <div className="studio-agent-message">
      <div className="studio-message-avatar"><TerminalSquare /></div>
      <div><div className="studio-message-meta">Runtime <span className={cn("studio-job-state", running && "is-running")}>{running ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />}{job.status}</span></div>
      <p>{running ? "Working in the isolated worktree. You can inspect changes or follow the run in Terminal." : "This task finished in the workspace. Review the changed files, then publish when you are ready."}</p></div>
    </div>
  </article>;
}

function TerminalPanel({ workspace, activeJob }: { workspace: Workspace; activeJob?: Job }) {
  return <div className="studio-terminal">
    <div className="studio-inspector-heading"><div><p>Terminal</p><span>{activeJob ? "Live run output" : "Workspace is standing by"}</span></div><TerminalSquare /></div>
    <pre><span className="terminal-muted">runtime@{workspace.provider}:~</span><span className="terminal-green">$</span> cd {workspace.worktreePath || "worktree"}{"\n"}<span className="terminal-muted">branch:</span> {workspace.branch}{"\n"}<span className="terminal-green">✓</span> {activeJob ? "Agent run is active…" : "Waiting for your next instruction."}</pre>
    <p className="studio-terminal-note">Run a task from chat to stream its output here.</p>
  </div>;
}
