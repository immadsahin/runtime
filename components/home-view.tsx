import Link from "next/link";
import { FolderPlus, SquarePen, Terminal } from "lucide-react";

import { HomeUserMenu } from "@/components/home-user-menu";
import { ProjectAvatar } from "@/components/project-avatar";
import type { Project } from "@/lib/runtime/types";

export type SessionItem = { id: string; title: string; project: string };

/**
 * The default home (Computer-style): every action lives in a full-height left
 * sidebar, and the center is just text — a greeting, a "Start" action, and the
 * last session to "Continue". Opening the last-session row drops back into that
 * workspace's studio; "New session" starts a fresh one.
 */
export function HomeView({
  ownerLogin,
  ownerAvatarUrl,
  activeProjects,
  lastSession,
}: {
  /** GitHub login of the signed-in owner — used for the greeting and the pill. */
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** Repositories with a live workspace — listed in the sidebar. */
  activeProjects: Project[];
  /** Most-recent session, surfaced as the single "Continue" link. */
  lastSession: SessionItem | null;
}) {
  const name = ownerLogin
    ? ownerLogin.charAt(0).toUpperCase() + ownerLogin.slice(1)
    : "there";

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden bg-background sm:grid-cols-[240px_1fr]">
      {/* Left sidebar — all actions. Hidden on narrow screens (the center's Start
          + Continue still cover the primary flow); shows from the sm breakpoint,
          below the desktop app's 720px min width. */}
      <aside className="hidden min-h-0 flex-col gap-6 border-r border-border/60 px-4 pb-4 pt-6 sm:flex">
        <div className="flex items-center gap-2 px-1 font-mono text-sm font-semibold text-foreground">
          <Terminal className="size-4" />
          outrunner
        </div>

        <nav className="space-y-0.5">
          <SidebarLink
            href="/new"
            icon={<SquarePen className="size-4" />}
            label="New session"
          />
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Workspaces
            </h2>
            <Link
              href="/new"
              aria-label="New session"
              className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FolderPlus className="size-3.5" />
            </Link>
          </div>
          <div className="mt-2 space-y-0.5">
            {activeProjects.length === 0 ? (
              <p className="px-1 py-1 text-sm text-muted-foreground">No workspaces yet</p>
            ) : (
              activeProjects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-sm text-foreground"
                >
                  <ProjectAvatar name={project.name} />
                  <span className="truncate">{project.name}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <HomeUserMenu ownerLogin={ownerLogin} ownerAvatarUrl={ownerAvatarUrl} />
      </aside>

      {/* Center — greeting + Start + Continue, text only. */}
      <main className="flex min-h-0 items-center justify-center overflow-y-auto px-6 sm:px-8">
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
            <Link
              href="/new"
              className="block py-1 text-[15px] text-foreground transition-colors hover:text-muted-foreground"
            >
              New session
            </Link>
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
    </div>
  );
}

/** A sidebar navigation link (routes somewhere). */
function SidebarLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
    >
      {icon}
      {label}
    </Link>
  );
}
