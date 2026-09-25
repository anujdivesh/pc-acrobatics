"use client";

import { useTerrainLayer } from "./TerrainProvider";
import { VEGETATION_TIERS } from "@/lib/terrain/vegetation";

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
      <Check
        checked={settings.enabled}
        onChange={(v) => update({ enabled: v })}
        label="Tonga bare earth and seabed"
      />

      {!settings.enabled ? (
        <p className="text-zinc-500">
          Quantized-mesh terrain gridded from the survey&apos;s ground and
          bathymetric-bottom classes, with the 10 cm orthophoto draped over it.
        </p>
      ) : status.error ? (
        <p className="text-red-600">{status.error}</p>
      ) : !status.meta ? (
        <p className="text-zinc-500">Loading terrain…</p>
      ) : (
        <>
          <div className="space-y-1">
            <Row label="Source" value={`${status.meta.resolution} m DEM`} />
            <Row label="Scale" value="1:1, true heights" />
            <Row
              label="Height here"
              value={status.sampleHeight === undefined ? "—" : `${status.sampleHeight.toFixed(1)} m`}
            />
            {status.ortho && (
              <Row label="Orthophoto" value={`${status.ortho.sourceResolution} m, z${status.ortho.maxzoom}`} />
            )}
          </div>

          <div className="space-y-1.5">
            <Check
              checked={settings.showOrtho}
              onChange={(v) => update({ showOrtho: v })}
              label="Orthophoto"
            />
            {settings.showOrtho && (
              <label className="block pl-5">
                <span className="text-zinc-500">
                  Opacity — {Math.round(settings.orthoAlpha * 100)}%
                </span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={settings.orthoAlpha}
                  onChange={(e) => update({ orthoAlpha: Number(e.target.value) })}
                  className="w-full accent-blue-600"
                />
              </label>
            )}
            <Check
              checked={settings.showBuildings}
              onChange={(v) => update({ showBuildings: v })}
              label={`Buildings${status.buildingCount ? ` (${status.buildingCount})` : ""}`}
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
                        {t.label} ({veg[t.cls].toLocaleString()})
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
