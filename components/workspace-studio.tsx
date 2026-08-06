"use client";

import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
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
import { SessionComposer } from "@/components/session-composer";
import { WorkspacePublishPanel } from "@/components/workspace-publish-panel";
import { WorkspaceSession } from "@/components/workspace-session";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type SideTab = "diff" | "publish";

export function WorkspaceStudio({
  project,
  workspace,
  workspaces,
  pullRequest,
  initialPrompt,
}: {
  project: Project;
  workspace: Workspace;
  workspaces: Workspace[];
  pullRequest: WorkspacePullRequest | null;
  /** First prompt carried in from the new-session screen, sent once connected. */
  initialPrompt?: string;
}) {
  const [activeTab, setActiveTab] = useState<SideTab>("diff");
  const [rightOpen, setRightOpen] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && workspace.provider === "daytona";

  return (
    <div className="studio-shell">
      <aside className="studio-rail" aria-label="Primary navigation">
        <Link className="studio-mark" href="/" aria-label="Runtime projects">
          <TerminalSquare />
        </Link>
        <div className="studio-rail-nav">
          <Link href="/" className="is-active" title="Workspaces"><Layers3 /></Link>
          <Link href="/new" title="New session"><Plus /></Link>
        </div>
        <div className="studio-avatar" aria-label="Account">R</div>
      </aside>

      <aside className="studio-sidebar">
        <div className="studio-project-head">
          <Link href="/" className="studio-back"><ArrowLeft /> Home</Link>
          <p className="studio-eyebrow">PROJECT</p>
          <h1 title={project.fullName}>{project.fullName}</h1>
          <span><GitBranch /> {project.defaultBranch}</span>
        </div>
        <Link href="/new" className="studio-new-thread">
          <Plus /> New session
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
            {hasLiveSession && (
              <button
                className={cn("studio-icon-button", showTerminal && "is-active")}
                onClick={() => setShowTerminal((open) => !open)}
                title={showTerminal ? "Hide terminal" : "Show terminal"}
              >
                <TerminalSquare />
              </button>
            )}
            <button className="studio-icon-button" onClick={() => setRightOpen((open) => !open)} title="Toggle inspector">
              {rightOpen ? <PanelRightClose /> : <FileDiff />}
            </button>
          </div>
        </header>

          {hasLiveSession ? (
            <WorkspaceSession
              workspaceId={workspace.id}
              showTerminal={showTerminal}
              initialPrompt={initialPrompt}
            />
          ) : (
            <div className="studio-offline">
              <div className="studio-empty-chat">
                <div className="studio-empty-icon"><MessageSquarePlus /></div>
                <h3>Live session unavailable</h3>
                <p>
                  {isReady
                    ? "Live sessions require the Daytona Runtime provider."
                    : "The workspace session will attach when provisioning completes."}
                </p>
              </div>
              <SessionComposer
                onSend={() => {}}
                canSend={false}
                disabledPlaceholder={
                  isReady
                    ? "Live sessions require the Daytona Runtime provider"
                    : "The session will attach once the workspace is ready"
                }
              />
            </div>
          )}
      </section>

      {rightOpen && (
        <aside className="studio-inspector">
          <div className="studio-inspector-tabs" role="tablist" aria-label="Workspace details">
            <InspectorTab active={activeTab === "diff"} onClick={() => setActiveTab("diff")} icon={<FileDiff />} label="Changes" />
            <InspectorTab active={activeTab === "publish"} onClick={() => setActiveTab("publish")} icon={<GitPullRequest />} label="Publish" />
            <button className="studio-close-inspector" onClick={() => setRightOpen(false)} title="Close inspector"><X /></button>
          </div>
          <div className="studio-inspector-content">
            {activeTab === "diff" && <>
              <div className="studio-inspector-heading"><div><p>Worktree changes</p><span>Compared with {workspace.baseBranch}</span></div><GitBranch /></div>
              <WorkspaceChanges workspaceId={workspace.id} active={isReady} />
            </>}
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
