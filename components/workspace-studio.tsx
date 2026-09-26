"use client";

import Link from "next/link";
import {
  ArrowLeft,
  FileDiff,
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";

import { ProjectWorkspaceNav } from "@/components/project-workspace-nav";
import { WorkspaceChanges } from "@/components/workspace-changes";
import { SessionComposer } from "@/components/session-composer";
import { WorkspaceSession } from "@/components/workspace-session";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

export function WorkspaceStudio({
  workspace,
  allProjects,
  allWorkspaces,
  initialPrompt,
}: {
  workspace: Workspace;
  allProjects: Project[];
  allWorkspaces: Workspace[];
  /** Kept for the page contract; the Publish panel was removed from the studio. */
  pullRequest: WorkspacePullRequest | null;
  /** First prompt carried in from the new-session screen, sent once connected. */
  initialPrompt?: string;
}) {
  const [rightOpen, setRightOpen] = useState(true);
  const [showTerminal] = useState(false);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && workspace.provider === "daytona";

  return (
    <div className={cn("studio-shell", !rightOpen && "no-inspector")}>
      <aside className="studio-sidebar">
        <div className="studio-brand"><Terminal /> outrunner</div>
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
          <div className="studio-inspector-tabs" aria-label="Workspace changes">
            <span className="studio-inspector-label"><FileDiff /> Changes</span>
            <button className="studio-close-inspector" onClick={() => setRightOpen(false)} title="Close inspector"><X /></button>
          </div>
          <div className="studio-inspector-content is-diff">
            <WorkspaceChanges workspaceId={workspace.id} active={isReady} baseBranch={workspace.baseBranch} />
          </div>
        </aside>
      )}
    </div>
  );
}
