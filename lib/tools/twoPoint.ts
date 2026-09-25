import type * as CesiumType from "cesium";
import { captureClicks, markerPoint, pickAt, refine, type Picked } from "./pick";

type Cesium = typeof CesiumType;

export type PickStage = "first" | "second" | "done";

type Options = {
  /** CSS colour for the end markers and the rubber band. */
  color: string;
  onStage: (stage: PickStage) => void;
  /** Both ends are down; draw the result with `addEntity`. */
  onComplete: (a: Picked, b: Picked) => void;
};

/**
 * Click two points on whatever is under the cursor; the shared half of the
 * measure and profile tools. A third click starts over.
 */
export class TwoPointPicker {
  private readonly release: () => void;
  private readonly entities: CesiumType.Entity[] = [];
  private a?: Picked;
  private b?: Picked;
  private hover?: CesiumType.Cartesian3;
  /** Bumped on every click and clear, so a slow terrain refine can't land late. */
  private seq = 0;

  constructor(
    private readonly Cesium: Cesium,
    private readonly viewer: CesiumType.Viewer,
    private readonly options: Options,
  ) {
    this.release = captureClicks(Cesium, viewer, {
      click: (p) => this.click(p),
      move: (p) => this.move(p),
    });
    this.options.onStage("first");
  }

  /** Add a graphic that belongs to the current pick, removed with it. */
  addEntity(options: CesiumType.Entity.ConstructorOptions) {
    const entity = this.viewer.entities.add(options);
    this.entities.push(entity);
    return entity;
  }

  removeEntity(entity: CesiumType.Entity) {
    const i = this.entities.indexOf(entity);
    if (i >= 0) this.entities.splice(i, 1);
    this.viewer.entities.remove(entity);
  }

  /** Remove the current pick and wait for a new first point. */
  clear() {
    for (const e of this.entities) this.viewer.entities.remove(e);
    this.entities.length = 0;
    this.a = this.b = this.hover = undefined;
    this.seq++;
    this.options.onStage("first");
  }

  destroy() {
    this.release();
    if (!this.viewer.isDestroyed()) this.clear();
  }

  private async click(windowPosition: CesiumType.Cartesian2) {
    const { Cesium, viewer } = this;
    const starting = !this.a || !!this.b;
    const seq = ++this.seq;
    const picked = await refine(Cesium, viewer,
      pickAt(Cesium, viewer, windowPosition, true, this.entities));
    if (!picked || seq !== this.seq || viewer.isDestroyed()) return;

    if (starting) {
      this.clear();
      this.a = picked;
      this.addEntity({ position: picked.position, point: markerPoint(Cesium, this.options.color) });
      this.addRubberBand();
      this.options.onStage("second");
      return;
    }
    if (!this.a) return;

    this.b = picked;
    this.addEntity({ position: picked.position, point: markerPoint(Cesium, this.options.color) });
    this.options.onStage("done");
    this.options.onComplete(this.a, this.b);
  }

  private move(windowPosition: CesiumType.Cartesian2) {
    if (!this.a || this.b) return;
    // Ground only: snapping to points on every mouse move would mean a pick
    // render pass per event over the whole cloud.
    this.hover = pickAt(this.Cesium, this.viewer, windowPosition, false)?.position ?? this.hover;
  }

  /** Line from the first point to the cursor, until the second click. */
  private addRubberBand() {
    const { Cesium } = this;
    this.addEntity({
      polyline: {
        positions: new Cesium.CallbackProperty(
          () => (this.b || !this.a ? [] : [this.a.position, this.hover ?? this.a.position]),
          false,
        ),
        width: 2,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(this.options.color),
        }),
      },
    });
  }
}
