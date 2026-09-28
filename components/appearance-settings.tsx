"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

const options = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

/** Appearance: a real theme switch backed by next-themes. Mounted-gated so the
 *  active state reflects the resolved theme and doesn't flash on hydration. */
export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // One-time mount flag so SSR/first paint doesn't assume a theme; not a render
  // cascade.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme : undefined;

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Appearance</h1>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Theme</p>
        <div className="flex gap-2">
          {options.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-pressed={current === value}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                current === value
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          The workspace studio is tuned for dark; light mode may have rough edges there.
        </p>
      </div>
    </section>
  );
}
