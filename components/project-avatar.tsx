import { cn } from "@/lib/utils";

/** Rounded-square project glyph — a deterministic gradient + the initial. */
export function ProjectAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initial = (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  let hue = 0;
  for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold text-white",
        className,
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 62% 56%), hsl(${(hue + 40) % 360} 68% 46%))`,
      }}
    >
      {initial}
    </span>
  );
}
