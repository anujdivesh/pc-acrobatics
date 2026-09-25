import type * as CesiumType from "cesium";
import {
  captureClicks, formatLength, markerLabel, markerPoint, pickAt, refine, type PickSource,
} from "./pick";

type Cesium = typeof CesiumType;

export const HEIGHT_COLOR = "#f472b6";

export type SpotHeight = {
  id: number;
  lng: number;
  lat: number;
  /** Height as the source stores it: the file's Z for LiDAR, the terrain's height otherwise. */
  height: number;
  source: PickSource;
};

/**
 * Click anything to read its height. Each click drops a labelled marker and
 * adds to the list; markers stay until cleared.
 */
export class HeightTool {
  private readonly release: () => void;
  private readonly entities = new Map<number, CesiumType.Entity>();
  private spots: SpotHeight[] = [];
  private nextId = 1;

  constructor(
    private readonly Cesium: Cesium,
    private readonly viewer: CesiumType.Viewer,
    private readonly onChange: (spots: SpotHeight[]) => void,
  ) {
    this.release = captureClicks(Cesium, viewer, { click: (p) => this.click(p) });
    this.onChange([]);
  }

  remove(id: number) {
    const entity = this.entities.get(id);
    if (entity) this.viewer.entities.remove(entity);
    this.entities.delete(id);
    this.spots = this.spots.filter((s) => s.id !== id);
    this.onChange(this.spots);
  }

  clear() {
    for (const e of this.entities.values()) this.viewer.entities.remove(e);
    this.entities.clear();
    this.spots = [];
    this.onChange(this.spots);
  }

  destroy() {
    this.release();
    if (!this.viewer.isDestroyed()) this.clear();
  }

  private async click(windowPosition: CesiumType.Cartesian2) {
    const { Cesium, viewer } = this;
    const picked = await refine(Cesium, viewer,
      pickAt(Cesium, viewer, windowPosition, true, [...this.entities.values()]));
    if (!picked || viewer.isDestroyed()) return;

    const carto = Cesium.Cartographic.fromCartesian(picked.position);
    const spot: SpotHeight = {
      id: this.nextId++,
      lng: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
      source: picked.source,
    };
    this.entities.set(spot.id, viewer.entities.add({
      position: picked.position,
      point: markerPoint(Cesium, HEIGHT_COLOR),
      label: markerLabel(Cesium, `${spot.id} · ${formatLength(spot.height)}`),
    }));
    this.spots = [...this.spots, spot];
    this.onChange(this.spots);
  }
}
