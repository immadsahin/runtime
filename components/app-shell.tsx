import Image from "next/image";
import Link from "next/link";
import { FolderGit2, HardDrive, LogOut, Settings2, Terminal } from "lucide-react";

import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Projects", icon: FolderGit2 },
  { href: "/workspaces", label: "Workspaces", icon: HardDrive },
  { href: "/setup", label: "Setup", icon: Settings2 },
];

export async function AppShell({
  children,
  active = "/",
}: {
  children: React.ReactNode;
  active?: string;
}) {
  const owner = await getOwnerSafe();

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

          <div className="ml-auto flex items-center gap-3">
            {owner ? (
              <>
                <div className="flex items-center gap-2">
                  {owner.avatarUrl && (
                    <Image
                      src={owner.avatarUrl}
                      alt=""
                      width={24}
                      height={24}
                      className="border-border/60 size-6 rounded-full border"
                    />
                  )}
                  <span className="text-muted-foreground font-mono text-xs">
                    {owner.githubLogin}
                  </span>
                </div>
                <form action={signOut}>
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon-sm"
                    title="Sign out"
                  >
                    <LogOut className="size-4" />
                    <span className="sr-only">Sign out</span>
                  </Button>
                </form>
              </>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href="/signin">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
