import type * as CesiumType from "cesium";
import { classColor, rampColor } from "./palette";
import type { ColorMode, NodeData } from "./types";

type Cesium = typeof CesiumType;

/**
 * Renders resident octree nodes into a Cesium PointPrimitiveCollection.
 *
 * One collection for the whole cloud, tracked per node so an octree drop can
 * remove exactly that node's points. Cesium batches the collection into a single
 * draw call, but every point is also a JS object with getters — which is what
 * bounds the budget here, not the GPU. A few hundred thousand is comfortable;
 * millions are not, and that is the point at which this should become a 3D Tiles
 * tileset rather than a bigger budget.
 */
export class PointCloudRenderer {
  private readonly collection: CesiumType.PointPrimitiveCollection;
  private readonly byNode = new Map<string, CesiumType.PointPrimitive[]>();
  private zMin = Number.NaN;
  private zSpan = Number.NaN;

  constructor(
    private readonly Cesium: Cesium,
    private readonly scene: CesiumType.Scene,
    private pointSize = 2,
  ) {
    this.collection = scene.primitives.add(
      new Cesium.PointPrimitiveCollection(),
    ) as CesiumType.PointPrimitiveCollection;
  }

  /**
   * Set the range the elevation ramp is stretched over. Changing it recolours
   * every point, so anything already drawn is dropped and rebuilt by the caller.
   */
  setElevationRange(min: number, max: number) {
    const span = Math.max(1e-6, max - min);
    if (min === this.zMin && span === this.zSpan) return;
    this.zMin = min;
    this.zSpan = span;
    if (this.byNode.size) this.clear();
  }

  setPointSize(size: number) {
    this.pointSize = size;
    for (const points of this.byNode.values()) {
      for (const p of points) p.pixelSize = size;
    }
  }

  has(key: string) {
    return this.byNode.has(key);
  }

  /** Keys currently resident, so the caller can drop what the octree dropped. */
  keys(): string[] {
    return [...this.byNode.keys()];
  }

  get pointCount() {
    let n = 0;
    for (const points of this.byNode.values()) n += points.length;
    return n;
  }

  private colourOf(node: NodeData, i: number, mode: ColorMode, out: Uint8Array) {
    if (mode === "rgb" && node.colors.length) {
      // LAS stores colour as 16-bit; the worker has already scaled it to 0-255.
      out[0] = node.colors[i * 3];
      out[1] = node.colors[i * 3 + 1];
      out[2] = node.colors[i * 3 + 2];
      return;
    }
    if (mode === "classification") {
      const [r, g, b] = classColor(node.classifications[i]);
      out[0] = r; out[1] = g; out[2] = b;
      return;
    }
    if (mode === "intensity") {
      const v = Math.min(255, node.intensities[i] >> 8);
      out[0] = v; out[1] = v; out[2] = v;
      return;
    }
    rampColor((node.elevations[i] - this.zMin) / this.zSpan, out, 0);
  }

  add(node: NodeData, mode: ColorMode, hidden: ReadonlySet<number>) {
    if (this.byNode.has(node.key)) return;
    const { Cesium } = this;
    const points: CesiumType.PointPrimitive[] = [];
    const rgb = new Uint8Array(3);
    for (let i = 0; i < node.pointCount; i++) {
      if (hidden.has(node.classifications[i])) continue;
      this.colourOf(node, i, mode, rgb);
      points.push(
        this.collection.add({
          position: Cesium.Cartesian3.fromDegrees(
            node.positions[i * 3],
            node.positions[i * 3 + 1],
            node.positions[i * 3 + 2],
          ),
          color: Cesium.Color.fromBytes(rgb[0], rgb[1], rgb[2], 255),
          pixelSize: this.pointSize,
        }),
      );
    }
    this.byNode.set(node.key, points);
  }

  drop(key: string) {
    const points = this.byNode.get(key);
    if (!points) return;
    for (const p of points) this.collection.remove(p);
    this.byNode.delete(key);
  }

  clear() {
    this.collection.removeAll();
    this.byNode.clear();
  }

  destroy() {
    this.clear();
    this.scene.primitives.remove(this.collection);
  }
}
