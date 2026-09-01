"use client";

import Link from "next/link";
import {
  ArrowLeft,
  FileDiff,
  GitBranch,
  GitPullRequest,
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";

import { ProjectWorkspaceNav } from "@/components/project-workspace-nav";
import { WorkspaceChanges } from "@/components/workspace-changes";
import { WorkspaceLifecycleControls } from "@/components/workspace-lifecycle-controls";
import { SessionComposer } from "@/components/session-composer";
import { WorkspacePublishPanel } from "@/components/workspace-publish-panel";
import { WorkspaceSession } from "@/components/workspace-session";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type SideTab = "diff" | "publish";

export function WorkspaceStudio({
  workspace,
  allProjects,
  allWorkspaces,
  pullRequest,
  initialPrompt,
}: {
  workspace: Workspace;
  allProjects: Project[];
  allWorkspaces: Workspace[];
  pullRequest: WorkspacePullRequest | null;
  /** First prompt carried in from the new-session screen, sent once connected. */
  initialPrompt?: string;
}) {
  const [activeTab, setActiveTab] = useState<SideTab>("diff");
  const [rightOpen, setRightOpen] = useState(true);
  const [showTerminal] = useState(false);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && workspace.provider === "daytona";

  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <div className="studio-sidebar-top">
          <Link href="/" className="studio-back"><ArrowLeft /> Home</Link>
          <Link href="/new" className="studio-back" title="New session"><Plus /> New</Link>
        </div>
        <ProjectWorkspaceNav
          projects={allProjects}
          workspaces={allWorkspaces}
          activeWorkspaceId={workspace.id}
        />
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
            <button className="studio-icon-button" onClick={() => setRightOpen((open) => !open)} title="Toggle changes">
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
                <WorkspaceLifecycleControls
                  workspaceId={workspace.id}
                  status={workspace.status}
                  provider={workspace.provider}
                />
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
