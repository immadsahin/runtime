"use client";

import Image from "next/image";
import Link from "next/link";
import { Info, LogOut, MessageSquare, Settings } from "lucide-react";

import { signOut } from "@/app/auth/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The bottom-of-sidebar user pill. Secondary actions (Settings, System info,
 * Feedback, Log out) live inside the popover it opens rather than as standalone
 * sidebar rows, keeping the rail to just the primary flow. Settings opens the
 * settings page and Log out runs the sign-out server action; System info /
 * Feedback stay placeholders until their destinations exist.
 */
export function HomeUserMenu({
  ownerLogin,
  ownerAvatarUrl,
}: {
  ownerLogin: string;
  ownerAvatarUrl: string | null;
}) {
  const label = ownerLogin || "signed in";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md border-t border-border/60 px-1 pt-3 text-left outline-none transition-colors hover:text-foreground">
        <Avatar url={ownerAvatarUrl} />
        <span className="truncate text-sm text-foreground">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <Avatar url={ownerAvatarUrl} />
          <span className="truncate">{label}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/general">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Info />
          System info
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <MessageSquare />
          Feedback
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <form action={signOut}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut />
              Log out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({ url }: { url: string | null }) {
  return url ? (
    <Image
      src={url}
      alt=""
      width={22}
      height={22}
      className="size-[22px] rounded-full border border-border/60"
    />
  ) : (
    <span className="size-[22px] shrink-0 rounded-full bg-accent" />
  );
}
