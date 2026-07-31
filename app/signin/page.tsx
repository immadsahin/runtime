import { redirect } from "next/navigation";
import { Terminal } from "lucide-react";

import { SignInButton } from "@/components/signin-button";
import { Card, CardContent } from "@/components/ui/card";
import { getOwnerSafe } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";

export const dynamic = "force-dynamic";

/** Human-readable copy for the error codes `/auth/callback` can return. */
const ERROR_MESSAGES: Record<string, string> = {
  not_owner:
    "That GitHub account is not the owner of this Runtime. Only the configured owner can sign in.",
  missing_code: "Sign-in did not complete. Please try again.",
  exchange_failed: "Could not verify the sign-in with GitHub. Please try again.",
  access_denied: "Sign-in was cancelled.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? "Sign-in failed. Please try again.";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = safeRelativePath(next);

  // Already signed in as the owner — skip the screen entirely.
  if (await getOwnerSafe()) redirect(target);

  const message = errorMessage(error);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-3 text-center">
          <div className="inline-flex items-center gap-2 font-mono text-sm">
            <Terminal className="size-4" />
            <span className="font-semibold tracking-tight">runtime</span>
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-muted-foreground text-sm">
              Personal cloud environment for running Claude Code.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="space-y-4 py-2">
            {message && (
              <div
                role="alert"
                className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
              >
                {message}
              </div>
            )}
            <SignInButton next={target} />
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-xs">
          Runtime is single-user. Only the configured GitHub account can sign
          in.
        </p>
      </div>
    </main>
  );
}
