"use client";

import { useState, type ReactNode } from "react";
import PointCloudPanel from "./PointCloudPanel";
import TerrainPanel from "./TerrainPanel";

type Item = {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
};

const PointCloudIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
    {[
      [5, 17], [8, 13], [11, 16], [14, 11], [17, 14], [20, 9],
      [6, 9], [10, 7], [13, 19], [17, 19], [19, 4], [4, 13],
    ].map(([cx, cy]) => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.7} />
    ))}
  </svg>
);

const TerrainIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" className="h-5 w-5" aria-hidden>
    <path d="M2 20 9 7l4 7 2-3 7 9Z" />
    <path d="m7.5 10 1.5 1.5L10.5 10" />
  </svg>
);

const ITEMS: Item[] = [
  {
    id: "copc",
    label: "Cloud Optimized Point Cloud",
    icon: PointCloudIcon,
    content: <PointCloudPanel />,
  },
  {
    id: "terrain",
    label: "3D Terrain Model",
    icon: TerrainIcon,
    content: <TerrainPanel />,
  },
];

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

export default function SidePanel() {
  // Desktop: the panel slides out from the left edge. Mobile: it is a bottom
  // sheet, collapsed to its handle until asked for, so the map keeps the screen.
  const [open, setOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(ITEMS[0].id);

  return (
    <aside
      className={`fixed inset-x-0 bottom-0 z-20 font-sans md:absolute md:inset-x-auto md:bottom-auto md:left-0 md:top-1/2 md:z-10 md:flex md:-translate-y-1/2 md:items-center md:transition-transform md:duration-300 ${
        open ? "md:translate-x-0" : "md:-translate-x-[calc(100%-2.25rem)]"
      }`}
    >
      {/* Mobile only: the sheet's header, with the same Hide / Show button as the products page. */}
      <div className="flex items-center gap-2 rounded-t-xl border border-b-0 border-zinc-300 bg-white/95 px-4 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,0.12)] backdrop-blur md:hidden">
        <span className="text-sm font-semibold text-zinc-800">Layers</span>
        <button
          type="button"
          onClick={() => setSheetOpen((o) => !o)}
          aria-expanded={sheetOpen}
          aria-controls="layer-panel"
          className="ml-auto shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700"
        >
          {sheetOpen ? "Hide" : "Show"}
        </button>
      </div>

      <nav
        id="layer-panel"
        className={`overflow-y-auto border-x border-zinc-300 bg-white/95 backdrop-blur transition-[max-height] duration-300 md:max-h-none md:w-72 md:overflow-visible md:rounded-r-xl md:border md:border-l-0 md:shadow-lg ${
          sheetOpen ? "max-h-[40vh]" : "max-h-0"
        }`}
      >
        <ul className="py-2">
          {ITEMS.map((item) => {
            const isOpen = expanded === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : item.id)}
                  aria-expanded={isOpen}
                  aria-controls={`panel-${item.id}`}
                  className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors ${
                    isOpen ? "text-blue-600" : "text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  <span className={isOpen ? "text-blue-600" : "text-zinc-900"}>{item.icon}</span>
                  <span className="whitespace-nowrap">{item.label}</span>
                  <Chevron
                    className={`ml-auto h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? "rotate-90" : "-rotate-90"}`}
                  />
                </button>
                <div
                  id={`panel-${item.id}`}
                  className={`grid transition-[grid-template-rows] duration-200 ${isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
                >
                  <div className="overflow-hidden">
                    <div className="mx-4 mb-2 rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-600">
                      {item.content}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Desktop only: the tab that slides the panel away. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Collapse panel" : "Expand panel"}
        className="-ml-px hidden h-12 w-9 items-center justify-center rounded-r-xl border border-l-0 border-zinc-300 bg-white/95 text-zinc-900 shadow-lg md:flex"
      >
        <Chevron className={`h-5 w-5 transition-transform duration-300 ${open ? "" : "rotate-180"}`} />
      </button>
    </aside>
  );
}
