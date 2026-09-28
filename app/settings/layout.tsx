import { redirect } from "next/navigation";

import { SettingsNav } from "@/components/settings-nav";
import { getOwnerSafe } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

/** Two-pane settings: a section nav on the left, the selected section on the
 *  right. Owner-gated like the rest of the control plane. */
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");

  return (
    <div className="grid h-dvh grid-cols-[240px_1fr] overflow-hidden bg-background">
      <SettingsNav />
      <main className="min-h-0 overflow-y-auto px-10 py-10">
        <div className="mx-auto max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
