import Link from "next/link";
import { FolderPlus, HelpCircle, Settings, SquarePen } from "lucide-react";

import { ProjectAvatar } from "@/components/project-avatar";
import type { Project } from "@/lib/runtime/types";

export type SessionItem = { id: string; title: string; project: string };
export type SessionGroup = { label: string; items: SessionItem[] };

/**
 * The default home: a light sessions list. Projects with a live workspace live
 * in a left rail; sessions are grouped by recency in the main column. Opening a
 * row drops into that workspace's studio; "New session" starts a fresh one.
 */
export function HomeView({
  activeProjects,
  groups,
}: {
  /** Repositories with a live workspace — shown in the rail. */
  activeProjects: Project[];
  groups: SessionGroup[];
}) {
  return (
    <div className="mx-auto grid max-w-4xl grid-cols-[190px_1fr] gap-14 px-8 pt-20">
      <aside className="space-y-8">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-neutral-700">Projects</h2>
            <Link
              href="/new"
              aria-label="New session"
              className="-mr-1 rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
            >
              <FolderPlus className="size-4" />
            </Link>
          </div>
          <div className="mt-3 space-y-0.5">
            {activeProjects.length === 0 ? (
              <p className="px-1 text-sm text-neutral-400">No active workspaces.</p>
            ) : (
              activeProjects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-[15px] text-neutral-800"
                >
                  <ProjectAvatar name={project.name} />
                  <span className="truncate">{project.name}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-0.5">
          <RailItem icon={<Settings className="size-4" />} label="Settings" />
          <RailItem icon={<HelpCircle className="size-4" />} label="Help" />
        </div>
      </aside>

      <main>
        <div className="mb-5 flex items-center justify-end">
          <Link
            href="/new"
            className="flex items-center gap-2 text-[15px] text-neutral-600 transition-colors hover:text-neutral-900"
          >
            <SquarePen className="size-4" /> New session
          </Link>
        </div>

        <div className="space-y-7">
          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="mb-2.5 text-[15px] text-neutral-500">{group.label}</h3>
              <div className="-mx-2 space-y-0.5">
                {group.items.map((session) => (
                  <Link
                    key={session.id}
                    href={`/workspaces/${session.id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-100"
                  >
                    <ProjectAvatar name={session.project} />
                    <span className="truncate font-semibold text-neutral-900">
                      {session.title}
                    </span>
                    <span className="truncate text-neutral-400">
                      {session.project}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function RailItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-1 py-1.5 text-[15px] text-neutral-500">
      {icon}
      {label}
    </div>
  );
}
