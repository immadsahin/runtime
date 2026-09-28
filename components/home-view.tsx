"use client";

import Link from "next/link";
import { FolderPlus, PanelLeft, PanelLeftOpen, SquarePen, Terminal } from "lucide-react";
import { useEffect, useState } from "react";

import { HomeUserMenu } from "@/components/home-user-menu";
import { NewSessionDialog } from "@/components/new-session-dialog";
import { ProjectAvatar } from "@/components/project-avatar";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

export type SessionItem = { id: string; title: string; project: string };

const COLLAPSE_KEY = "home-sidebar-collapsed";

/**
 * The default home (Computer-style): every action lives in a collapsible
 * full-height left sidebar, and the center is just text — a greeting, a Start
 * action, and the last session to Continue. New sessions open in a modal
 * (defaulting to the last project); clicking a sidebar project preselects it.
 */
export function HomeView({
  ownerLogin,
  ownerAvatarUrl,
  activeProjects,
  projects,
  lastSession,
  lastProjectId,
}: {
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** Projects with a live workspace — listed in the sidebar. */
  activeProjects: Project[];
  /** Every repository — feeds the new-session modal's picker. */
  projects: Project[];
  /** Most-recent session, surfaced as the single "Continue" link. */
  lastSession: SessionItem | null;
  /** Repo of the most-recent session — the modal's default project. */
  lastProjectId?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [preselected, setPreselected] = useState<string | undefined>(lastProjectId);

  // Restore the persisted collapse state after hydration (reading localStorage
  // during render would mismatch SSR). A one-time sync, not a render cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Private mode / storage disabled — collapse just won't persist.
      }
      return next;
    });

  const openNew = (projectId?: string) => {
    setPreselected(projectId ?? lastProjectId);
    setModalOpen(true);
  };

  const name = ownerLogin
    ? ownerLogin.charAt(0).toUpperCase() + ownerLogin.slice(1)
    : "there";

  return (
    <div
      className={cn(
        "grid h-dvh overflow-hidden bg-background",
        collapsed ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-[240px_1fr]",
      )}
    >
      {/* Left sidebar — all actions. Hidden on narrow screens and when collapsed;
          the center's Start + Continue still cover the primary flow. */}
      {!collapsed && (
        <aside className="hidden min-h-0 flex-col gap-6 border-r border-border/60 px-4 pb-4 pt-6 sm:flex">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2 font-mono text-sm font-semibold text-foreground">
              <Terminal className="size-4" />
              outrunner
            </div>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelLeft className="size-4" />
            </button>
          </div>

          <nav className="space-y-0.5">
            <button
              type="button"
              onClick={() => openNew()}
              className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <SquarePen className="size-4" />
              New session
            </button>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Workspaces
              </h2>
              <button
                type="button"
                onClick={() => openNew()}
                aria-label="New session"
                className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderPlus className="size-3.5" />
              </button>
            </div>
            <div className="mt-2 space-y-0.5">
              {activeProjects.length === 0 ? (
                <p className="px-1 py-1 text-sm text-muted-foreground">No workspaces yet</p>
              ) : (
                activeProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => openNew(project.id)}
                    className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <ProjectAvatar name={project.name} />
                    <span className="truncate">{project.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <HomeUserMenu ownerLogin={ownerLogin} ownerAvatarUrl={ownerAvatarUrl} />
        </aside>
      )}

      {/* Center — greeting + Start + Continue, text only. */}
      <main className="relative flex min-h-0 items-center justify-center overflow-y-auto px-6 sm:px-8">
        {collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="absolute left-4 top-4 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        )}

        <div className="w-full max-w-sm space-y-8 py-16">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Taking a breather, {name}?
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              @{ownerLogin || "outrunner"} · outrunner
            </p>
          </div>

          <section>
            <h2 className="mb-2 text-sm text-muted-foreground">Start</h2>
            <button
              type="button"
              onClick={() => openNew()}
              className="block py-1 text-[15px] text-foreground transition-colors hover:text-muted-foreground"
            >
              New session
            </button>
          </section>

          {lastSession && (
            <section>
              <h2 className="mb-2 text-sm text-muted-foreground">Continue</h2>
              <Link
                href={`/workspaces/${lastSession.id}`}
                className="group flex items-baseline gap-2 py-1"
              >
                <span className="min-w-0 truncate font-semibold text-foreground transition-colors group-hover:text-muted-foreground">
                  {lastSession.title}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {lastSession.project}
                </span>
              </Link>
            </section>
          )}
        </div>
      </main>

      <NewSessionDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        projects={projects}
        initialProjectId={preselected}
      />
    </div>
  );
}
