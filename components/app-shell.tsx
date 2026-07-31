import Link from "next/link";
import { Boxes, FolderGit2, Terminal } from "lucide-react";

import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Projects", icon: FolderGit2 },
  { href: "/workspaces", label: "Workspaces", icon: Boxes },
];

export function AppShell({
  children,
  active = "/",
}: {
  children: React.ReactNode;
  active?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-border/60 bg-card/40 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
          <Link href="/" className="flex items-center gap-2 font-mono text-sm">
            <Terminal className="size-4" />
            <span className="font-semibold tracking-tight">runtime</span>
          </Link>
          <nav className="flex items-center gap-1">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                  active === href
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
