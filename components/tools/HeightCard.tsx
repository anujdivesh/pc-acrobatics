"use client";

import { useEffect, useRef, useState } from "react";
import type { MapHandle } from "../MapProvider";
import { HeightTool, type SpotHeight } from "@/lib/tools/height";
import { SOURCE_LABEL, formatLength } from "@/lib/tools/pick";
import { CloseButton } from "./CloseButton";

export default function HeightCard({ map, onClose }: { map: NonNullable<MapHandle>; onClose: () => void }) {
  const [spots, setSpots] = useState<SpotHeight[]>([]);
  const toolRef = useRef<HeightTool | null>(null);

  useEffect(() => {
    const tool = new HeightTool(map.cesium, map.viewer, setSpots);
    toolRef.current = tool;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tool.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      toolRef.current = null;
      tool.destroy();
    };
  }, [map]);

  return (
    <section className="w-64 rounded-xl border border-zinc-300 bg-white/95 p-3 text-xs text-zinc-600 shadow-lg backdrop-blur">
      <header className="mb-2 flex items-center">
        <h2 className="text-sm font-medium text-blue-600">Spot height</h2>
        <CloseButton label="Close spot height tool" onClick={onClose} />
      </header>

      {spots.length === 0 ? (
        <p>Click anywhere on the point cloud or terrain to read its height.</p>
      ) : (
        <>
          <ol className="max-h-64 divide-y divide-zinc-200 overflow-y-auto rounded-md bg-zinc-100">
            {spots.map((s) => (
              <li key={s.id} className="group flex items-start gap-2 px-3 py-1.5">
                <span className="w-4 shrink-0 text-zinc-400 tabular-nums">{s.id}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium tabular-nums text-zinc-900">{formatLength(s.height)}</div>
                  <div className="tabular-nums text-zinc-500">
                    {s.lat.toFixed(6)}, {s.lng.toFixed(6)} · {SOURCE_LABEL[s.source]}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toolRef.current?.remove(s.id)}
                  aria-label={`Remove spot ${s.id}`}
                  className="rounded px-1 text-zinc-400 opacity-0 hover:bg-zinc-200 hover:text-zinc-700 focus:opacity-100 group-hover:opacity-100"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex items-center">
            <p className="text-zinc-500">Click to add more.</p>
            <button
              type="button"
              onClick={() => toolRef.current?.clear()}
              className="ml-auto rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
            >
              Clear
            </button>
          </div>
        </>
      )}
      <p className="mt-2 text-[11px] leading-4 text-zinc-400">
        LiDAR heights are the file&apos;s own Z values; the file declares no vertical datum.
      </p>
    </section>
  );
}
