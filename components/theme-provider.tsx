"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Client wrapper for next-themes so the root layout can stay a server
 *  component. Dark is the default, so existing users see no change unless they
 *  pick another theme in Settings → Appearance. */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
