"use client";

import type { Legend as LegendSpec } from "./types";

export function Legend({ legend }: { legend?: LegendSpec }) {
  if (!legend) return null;
  if (legend.type === "ramp") {
    return (
      <div>
        {legend.label && <p className="mb-1 text-[11px] text-zinc-500">{legend.label}</p>}
        <div className="h-2.5 rounded-sm" style={{
          background: `linear-gradient(to right, ${legend.stops.map(([, c]) => c).join(", ")})`,
        }} />
        <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-zinc-500">
          {legend.stops.map(([v]) => <span key={v}>{v}</span>)}
        </div>
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {legend.items.map(([label, color]) => (
        <li key={label} className="flex items-center gap-2 text-[11px] text-zinc-600">
          <span className="h-3 w-3 shrink-0 rounded-sm border border-black/10" style={{ background: color }} />
          {label}
        </li>
      ))}
    </ul>
  );
}
