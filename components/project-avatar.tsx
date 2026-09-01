import { cn } from "@/lib/utils";

/** Rounded-square project glyph — the initial on a neutral surface. */
export function ProjectAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initial = (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-neutral-700 text-[11px] font-semibold text-neutral-100",
        className,
      )}
    >
      {initial}
    </span>
  );
}
