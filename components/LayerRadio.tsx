"use client";

import { usePointCloud } from "./PointCloudProvider";
import { useTerrainLayer } from "./TerrainProvider";

export type SurveyLayer = "pointcloud" | "terrain";

/**
 * The survey's two products are alternatives, not layers to stack: picking one
 * switches the other off. Both panels render one of these under the same group.
 */
export default function LayerRadio({ layer, label }: { layer: SurveyLayer; label: string }) {
  const pointCloud = usePointCloud();
  const terrain = useTerrainLayer();
  const checked = layer === "pointcloud" ? pointCloud.settings.enabled : terrain.settings.enabled;

  const select = () => {
    pointCloud.update({ enabled: layer === "pointcloud" });
    terrain.update({ enabled: layer === "terrain" });
  };

  return (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name="survey-layer"
        value={layer}
        checked={checked}
        onChange={select}
        className="h-3.5 w-3.5 accent-blue-600"
      />
      <span className="text-zinc-800">{label}</span>
    </label>
  );
}
