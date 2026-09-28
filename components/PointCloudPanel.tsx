"use client";

import { usePointCloud } from "./PointCloudProvider";
import LayerRadio from "./LayerRadio";
import { COLOR_MODE_LABELS, classLabel, rampCss } from "@/lib/copc/palette";
import type { ColorMode } from "@/lib/copc/types";

const MODES: ColorMode[] = ["elevation", "classification", "rgb"];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 tabular-nums">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-800">{value}</span>
    </div>
  );
}

export default function PointCloudPanel() {
  const { settings, update, status, zoomToData } = usePointCloud();
  const meta = status.metadata;

  const classes = Object.entries(status.histogram)
    .map(([code, n]) => [Number(code), n] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  return (
    <div className="space-y-3">
      <LayerRadio layer="pointcloud" label="Mango Island topo-bathy" />

      {!settings.enabled ? (
        <p className="text-zinc-500">
          Classified COPC file
        </p>
      ) : status.error ? (
        <p className="text-red-600">{status.error}</p>
      ) : !meta ? (
        <p className="text-zinc-500">Reading header…</p>
      ) : (
        <>
          

          <div>
            <div className="mb-1 text-zinc-500">Colour</div>
            <div className="flex flex-wrap gap-1">
              {MODES.filter((m) => m !== "rgb" || meta.hasColor).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => update({ colorMode: m })}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    settings.colorMode === m
                      ? "bg-blue-600 text-white"
                      : "bg-white text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  {COLOR_MODE_LABELS[m]}
                </button>
              ))}
            </div>
            {settings.colorMode === "elevation" && (
              <div className="mt-1.5">
                <div className="h-2 w-full rounded" style={{ background: rampCss() }} />
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>{(status.rampRange ?? meta.zRange)[0].toFixed(0)} m</span>
                  <span>{(status.rampRange ?? meta.zRange)[1].toFixed(0)} m</span>
                </div>
              </div>
            )}
          </div>

          <label className="block">
            <span className="text-zinc-500">Point size — {settings.pointSize}px</span>
            <input
              type="range" min={1} max={8} step={1}
              value={settings.pointSize}
              onChange={(e) => update({ pointSize: Number(e.target.value) })}
              className="w-full accent-blue-600"
            />
          </label>


          {classes.length > 0 && (
            <div>
              <div className="mb-1 text-zinc-500">Classification</div>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
                {classes.map(([code]) => (
                  <li key={code}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!settings.hidden.includes(code)}
                        onChange={(e) =>
                          update({
                            hidden: e.target.checked
                              ? settings.hidden.filter((c) => c !== code)
                              : [...settings.hidden, code],
                          })
                        }
                        className="h-3 w-3 accent-blue-600"
                      />
                      <span className="truncate text-zinc-700">{classLabel(code)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={zoomToData}
            className="w-full rounded bg-white px-2 py-1 text-zinc-700 shadow-sm transition-colors hover:text-zinc-900"
          >
            Zoom to data
          </button>
        </>
      )}
    </div>
  );
}
