"use client";

import { useState, type ReactNode } from "react";
import { useMap } from "./MapProvider";
import MeasureCard from "./tools/MeasureCard";
import HeightCard from "./tools/HeightCard";
import ProfilePanel from "./tools/ProfilePanel";

type ToolId = "measure" | "profile" | "height";

const RulerIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
    <path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z" />
    <path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2" />
  </svg>
);

const ProfileIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
    <path d="M3 3v18h18" />
    <path d="m7 15 3-5 3 3 3-6 3 4" />
  </svg>
);

const HeightIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
    <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Z" />
    <path d="M12 8v5M10 10l2-2 2 2" />
  </svg>
);

const TOOLS: { id: ToolId; label: string; icon: ReactNode }[] = [
  { id: "measure", label: "Measure distance", icon: RulerIcon },
  { id: "profile", label: "Elevation profile", icon: ProfileIcon },
  { id: "height", label: "Spot height", icon: HeightIcon },
];

export default function ToolsPanel() {
  const { map } = useMap();
  const [active, setActive] = useState<ToolId | null>(null);
  const close = () => setActive(null);

  return (
    <>
      <aside className="absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-start gap-2 font-sans">
        {map && active === "measure" && <MeasureCard map={map} onClose={close} />}
        {map && active === "height" && <HeightCard map={map} onClose={close} />}

        <nav className="flex flex-col gap-1 rounded-l-xl border border-r-0 border-zinc-300 bg-white/95 p-1.5 shadow-lg backdrop-blur">
          {TOOLS.map((tool) => {
            const isActive = active === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => setActive(isActive ? null : tool.id)}
                disabled={!map}
                aria-pressed={isActive}
                aria-label={tool.label}
                title={tool.label}
                className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
                  isActive ? "bg-blue-50 text-blue-600" : "text-zinc-900 hover:bg-zinc-100"
                }`}
              >
                {tool.icon}
              </button>
            );
          })}
        </nav>
      </aside>

      {map && active === "profile" && <ProfilePanel map={map} onClose={close} />}
    </>
  );
}
