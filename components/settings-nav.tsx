"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, Info, Palette, User } from "lucide-react";

import { cn } from "@/lib/utils";

const sections = [
  { href: "/settings/general", label: "General", icon: Info },
  { href: "/settings/appearance", label: "Appearance", icon: Palette },
  { href: "/settings/account", label: "Account", icon: User },
];

/** The settings-nav column: a Back link home, then the section links with the
 *  active one highlighted (Computer-style two-pane settings). */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <aside role="navigation" aria-label="Settings" className="flex min-h-0 flex-col gap-0.5 border-r border-border/60 px-4 py-6">
      <Link
        href="/"
        className="mb-3 flex items-center gap-1.5 px-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> Back
      </Link>
      {sections.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
          </Link>
        );
      })}
    </aside>
  );
}
