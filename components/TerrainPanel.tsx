"use client";

import { useTerrainLayer } from "./TerrainProvider";
import LayerRadio from "./LayerRadio";
import { VEGETATION_TIERS } from "@/lib/terrain/vegetation";
import { RELIEF_STOPS } from "@/lib/terrain/relief";

const CONTOUR_SPACINGS = [0.5, 1, 2, 5, 10];

/** The relief ramp, one equal-width segment per stop interval, labelled at the stops. */
function ReliefLegend() {
  // The waterline is a colour break (-0.01 -> 0), not a segment of its own: the
  // segment ending at 0 fades to the water side's colour, the next starts on land's.
  const waterEdge = RELIEF_STOPS.find(([v]) => v === -0.01)![1];
  const stops = RELIEF_STOPS.filter(([v]) => v !== -0.01);
  return (
    <div className="pl-5">
      <div className="flex h-2.5 overflow-hidden rounded-sm">
        {stops.slice(0, -1).map(([v, from], i) => {
          const [nextV, nextC] = stops[i + 1];
          const to = nextV === 0 ? waterEdge : nextC;
          return <div key={v} className="flex-1" style={{ background: `linear-gradient(to right, ${from}, ${to})` }} />;
        })}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-zinc-500">
        {stops.map(([v]) => (
          <span key={v}>{v > 0 ? `+${v}` : v}</span>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 tabular-nums">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-800">{value}</span>
    </div>
  );
}

function Check({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-blue-600"
      />
      <span className="text-zinc-700">{label}</span>
    </label>
  );
}

export default function TerrainPanel() {
  const { settings, update, status, zoomToData } = useTerrainLayer();
  const veg = status.vegetationCounts ?? {};

  return (
    <div className="space-y-3">
      <LayerRadio layer="terrain" label="Mango Island 3D Terrain" />

      {!settings.enabled ? (
        <p className="text-zinc-500">
         3D Terrain gridded from TopoBathy, with the 10 cm orthophoto overlay.
        </p>
      ) : status.error ? (
        <p className="text-red-600">{status.error}</p>
      ) : !status.meta ? (
        <p className="text-zinc-500">Loading terrain…</p>
      ) : (
        <>
         

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Check
                checked={settings.showOrtho}
                onChange={(v) => update({ showOrtho: v })}
                label="Orthophoto"
              />
              {settings.showOrtho && (
                <>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={settings.orthoAlpha}
                    onChange={(e) => update({ orthoAlpha: Number(e.target.value) })}
                    aria-label="Orthophoto opacity"
                    className="min-w-0 flex-1 accent-blue-600"
                  />
                  <span className="w-8 text-right tabular-nums text-zinc-500">
                    {Math.round(settings.orthoAlpha * 100)}%
                  </span>
                </>
              )}
            </div>
            <Check
              checked={settings.showRelief}
              // Trees and buildings would hide the colours: switching them on clears both.
              onChange={(v) => update(v ? { showRelief: true, showVegetation: false, showBuildings: false } : { showRelief: false })}
              label="Depth and elevation colours"
            />
            
            <div className="flex items-center gap-2">
              <Check
                checked={settings.showContours}
                onChange={(v) => update(v ? { showContours: true, showVegetation: false, showBuildings: false } : { showContours: false })}
                label="Contours"
              />
              {settings.showContours && (
                <label className="flex items-center gap-1.5 text-zinc-500">
                  every
                  <select
                    value={settings.contourSpacing}
                    onChange={(e) => update({ contourSpacing: Number(e.target.value) })}
                    className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-zinc-800"
                    aria-label="Contour spacing"
                  >
                    {CONTOUR_SPACINGS.map((m) => (
                      <option key={m} value={m}>{m} m</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          
            <Check
              checked={settings.showBuildings}
              onChange={(v) => update({ showBuildings: v })}
              label="Buildings"
            />
            <Check
              checked={settings.showVegetation}
              onChange={(v) => update({ showVegetation: v })}
              label="Vegetation"
            />
            {settings.showVegetation && (
              <ul className="space-y-0.5 pl-5">
                {VEGETATION_TIERS.filter((t) => veg[t.cls]).map((t) => (
                  <li key={t.cls}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={settings.vegetationTiers[t.cls]}
                        onChange={(e) =>
                          update({
                            vegetationTiers: {
                              ...settings.vegetationTiers,
                              [t.cls]: e.target.checked,
                            },
                          })
                        }
                        className="h-3 w-3 accent-blue-600"
                      />
                      <span className="truncate text-zinc-600">
                        {t.label}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            onClick={zoomToData}
            className="w-full rounded bg-white px-2 py-1 text-zinc-700 shadow-sm transition-colors hover:text-zinc-900"
          >
            Zoom to terrain
          </button>
        </>
      )}
    </div>
  );
}
