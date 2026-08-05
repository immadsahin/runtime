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
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import { useState } from "react";

import { WorkspaceChanges } from "@/components/workspace-changes";
import { WorkspaceLifecycleControls } from "@/components/workspace-lifecycle-controls";
import { WorkspacePublishPanel } from "@/components/workspace-publish-panel";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type SideTab = "diff" | "terminal" | "publish";

export function WorkspaceStudio({
  project,
  workspace,
  workspaces,
  pullRequest,
}: {
  project: Project;
  workspace: Workspace;
  workspaces: Workspace[];
  pullRequest: WorkspacePullRequest | null;
}) {
  const [activeTab, setActiveTab] = useState<SideTab>("diff");
  const [rightOpen, setRightOpen] = useState(true);
  const isReady = workspace.status === "ready" || workspace.status === "idle";

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
            <button className="studio-icon-button" onClick={() => setRightOpen((open) => !open)} title="Toggle inspector">
              {rightOpen ? <PanelRightClose /> : <FileDiff />}
            </button>
          </div>
        </header>

        <div className="studio-conversation">
          <div className="studio-run-notice">
            <span><TerminalSquare /> WORKSPACE</span>
            <p>Every session runs in this isolated worktree. Changes remain on <code>{workspace.branch}</code> until you publish a pull request.</p>
          </div>

          <div className="studio-empty-chat">
            <div className="studio-empty-icon"><MessageSquarePlus /></div>
            <h3>Interactive session coming soon</h3>
            <p>The live terminal and conversation view land in the next milestone. Inspect worktree changes or publish this workspace from the panel.</p>
          </div>
        </div>
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
            {activeTab === "terminal" && <TerminalPanel workspace={workspace} />}
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

function TerminalPanel({ workspace }: { workspace: Workspace }) {
  return <div className="studio-terminal">
    <div className="studio-inspector-heading"><div><p>Terminal</p><span>Workspace is standing by</span></div><TerminalSquare /></div>
    <pre><span className="terminal-muted">runtime@{workspace.provider}:~</span><span className="terminal-green">$</span> cd {workspace.worktreePath || "worktree"}{"\n"}<span className="terminal-muted">branch:</span> {workspace.branch}{"\n"}<span className="terminal-green">✓</span> Waiting for the live session (next milestone).</pre>
    <p className="studio-terminal-note">The interactive terminal streams here once the session UI ships.</p>
  </div>;
}
