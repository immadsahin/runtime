import { redirect } from "next/navigation";

/** /settings opens on the General section. */
export default function SettingsIndex() {
  redirect("/settings/general");
}
