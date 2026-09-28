import Image from "next/image";
import { redirect } from "next/navigation";

import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { getOwnerSafe } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

/** Account: the signed-in GitHub identity and sign-out. */
export default async function AccountSettings() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Account</h1>

      <div className="flex items-center gap-3">
        {owner.avatarUrl ? (
          <Image
            src={owner.avatarUrl}
            alt=""
            width={40}
            height={40}
            className="size-10 rounded-full border border-border/60"
          />
        ) : (
          <span className="size-10 rounded-full bg-accent" />
        )}
        <div>
          <p className="text-sm font-medium text-foreground">
            {owner.githubLogin || "signed in"}
          </p>
          <p className="text-xs text-muted-foreground">Signed in with GitHub</p>
        </div>
      </div>

      <form action={signOut}>
        <Button type="submit" variant="outline" size="sm">
          Sign out
        </Button>
      </form>
    </section>
  );
}
