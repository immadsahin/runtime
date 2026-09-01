"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/** The GitHub "Octocat" mark. Inlined so it does not depend on a lucide icon. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="size-4">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Starts the GitHub OAuth (PKCE) flow from the browser. Supabase stores the
 * code verifier in a cookie and redirects to GitHub; the `/auth/callback`
 * route completes the exchange and enforces the owner allowlist.
 *
 * OAuth is used for identity only — repository access uses a separate PAT —
 * so the requested scopes are the minimum needed to read the account login.
 */
export function SignInButton({ next = "/" }: { next?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo, scopes: "read:user user:email" },
      });

      // On success the browser navigates away, so we only reach here on failure.
      if (error) throw error;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not start sign-in.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={signIn}
        disabled={loading}
        variant="outline"
        size="lg"
        className="w-full"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <GitHubMark />
        )}
        Continue with GitHub
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
