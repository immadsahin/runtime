"use client";

import { parseUnifiedDiff, type DiffLine } from "@/lib/runtime/diff";

// Redundant per-file headers the panel already conveys (it shows the path); hide
// them so the diff reads clean like a source-control view, keeping only hunk
// headers, body lines, and informative notices (binary / no-newline).
const REDUNDANT_META = /^(diff --git|index |--- |\+\+\+ |old mode|new mode|similarity |rename )/;

function rowClass(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-emerald-500/10 text-emerald-300";
    case "del":
      return "bg-rose-500/10 text-rose-300";
    case "hunk":
      return "bg-muted/60 text-muted-foreground";
    case "meta":
      return "text-muted-foreground/70";
    default:
      return "text-foreground/90";
  }
}

const marker = (type: DiffLine["type"]) => (type === "add" ? "+" : type === "del" ? "-" : " ");

/** Render a bounded unified diff inline with red/green lines + a line-number
 *  gutter. Pure presentation over {@link parseUnifiedDiff}. */
export function DiffView({ diff }: { diff: string }) {
  const lines = parseUnifiedDiff(diff).filter(
    (line) => !(line.type === "meta" && REDUNDANT_META.test(line.text)),
  );

  if (lines.length === 0) {
    return <p className="text-muted-foreground text-xs">No diff to show.</p>;
  }

  return (
    <div className="max-h-96 overflow-auto rounded-md border font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={`flex ${rowClass(line.type)}`}>
          <span className="text-muted-foreground/50 w-8 shrink-0 select-none px-1 text-right">
            {line.oldNumber ?? ""}
          </span>
          <span className="text-muted-foreground/50 w-8 shrink-0 select-none px-1 text-right">
            {line.newNumber ?? ""}
          </span>
          <span className="w-3 shrink-0 select-none text-center">{marker(line.type)}</span>
          <span className="flex-1 break-all whitespace-pre-wrap pr-2">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
