import { redirect } from "next/navigation";

// Workspaces are the home surface now; keep the old path working.
export default function WorkspacesPage() {
  redirect("/");
}
