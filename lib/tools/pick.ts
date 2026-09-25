import type * as CesiumType from "cesium";

type Cesium = typeof CesiumType;

/** What a click landed on. */
export type PickSource = "point" | "terrain" | "surface";

export type Picked = { position: CesiumType.Cartesian3; source: PickSource };

export const SOURCE_LABEL: Record<PickSource, string> = {
  point: "LiDAR point",
  terrain: "Terrain",
  surface: "Surface",
};

/**
 * What is under the cursor, in world coordinates.
 *
 * With `snap`, a click on a LiDAR point returns that point's own coordinates, so
 * anything derived from it is exact to the data; a click on some other object,
 * such as a building, reads the depth buffer. Otherwise it intersects the
 * terrain mesh. `ignore` keeps a tool from picking its own markers.
 */
export function pickAt(
  Cesium: Cesium,
  viewer: CesiumType.Viewer,
  windowPosition: CesiumType.Cartesian2,
  snap: boolean,
  ignore: readonly CesiumType.Entity[] = [],
): Picked | undefined {
  const { scene, camera } = viewer;

  if (snap) {
    // Points are drawn a couple of pixels wide, so pick a small box around the
    // cursor. Cesium searches it from the centre outwards, so the nearest wins.
    const picked = scene.pick(windowPosition, 7, 7);
    if (picked?.primitive instanceof Cesium.PointPrimitive) {
      return { position: Cesium.Cartesian3.clone(picked.primitive.position), source: "point" };
    }
    const ours = picked?.id && ignore.includes(picked.id);
    if (picked && !ours && scene.pickPositionSupported) {
      const position = scene.pickPosition(windowPosition);
      if (Cesium.defined(position)) return { position, source: "surface" };
    }
  }

  // Bare ground: intersect the terrain mesh directly. The depth buffer is too
  // coarse here once the camera is more than a few kilometres out.
  const ray = camera.getPickRay(windowPosition);
  const position = ray && scene.globe.pick(ray, scene);
  return position ? { position, source: "terrain" } : undefined;
}

/**
 * Replace a terrain pick's height with the terrain's most detailed height at
 * that spot. The mesh on screen is whatever level of detail the camera distance
 * called for, and is also drawn with the scene's vertical exaggeration applied;
 * neither belongs in a measurement.
 */
export async function refine(
  Cesium: Cesium,
  viewer: CesiumType.Viewer,
  picked: Picked | undefined,
): Promise<Picked | undefined> {
  if (!picked || picked.source !== "terrain") return picked;
  const { scene } = viewer;
  const carto = Cesium.Cartographic.fromCartesian(picked.position);

  try {
    const [sampled] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto.clone()]);
    if (sampled && Number.isFinite(sampled.height)) {
      return { position: Cesium.Cartographic.toCartesian(sampled), source: "terrain" };
    }
  } catch {
    // No availability metadata (e.g. a plain ellipsoid): fall through.
  }

  const scale = scene.verticalExaggeration;
  const relative = scene.verticalExaggerationRelativeHeight;
  carto.height = (carto.height - relative) / scale + relative;
  return { position: Cesium.Cartographic.toCartesian(carto), source: "terrain" };
}

type Handlers = {
  click: (position: CesiumType.Cartesian2) => void;
  move?: (position: CesiumType.Cartesian2) => void;
};

/**
 * Route canvas clicks to a tool. The viewer's own click selects entities and
 * opens the info box, and its double click flies to them; neither should fire
 * while a tool is active, so both are parked until the returned release runs.
 */
export function captureClicks(Cesium: Cesium, viewer: CesiumType.Viewer, handlers: Handlers) {
  const { ScreenSpaceEventType } = Cesium;
  const input = viewer.screenSpaceEventHandler;
  const savedClick = input.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const savedDoubleClick = input.getInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  input.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
  input.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction(
    (e: CesiumType.ScreenSpaceEventHandler.PositionedEvent) => handlers.click(e.position),
    ScreenSpaceEventType.LEFT_CLICK,
  );
  const { move } = handlers;
  if (move) {
    handler.setInputAction(
      (e: CesiumType.ScreenSpaceEventHandler.MotionEvent) => move(e.endPosition),
      ScreenSpaceEventType.MOUSE_MOVE,
    );
  }
  viewer.canvas.style.cursor = "crosshair";

  return () => {
    handler.destroy();
    if (viewer.isDestroyed()) return;
    viewer.canvas.style.cursor = "";
    if (savedClick) input.setInputAction(savedClick, ScreenSpaceEventType.LEFT_CLICK);
    if (savedDoubleClick) input.setInputAction(savedDoubleClick, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  };
}

/** Centimetres up to 10 km: LiDAR is measured at that resolution. */
export function formatLength(metres: number) {
  if (Math.abs(metres) >= 10_000) return `${(metres / 1000).toFixed(3)} km`;
  return `${metres.toFixed(2)} m`;
}

export function formatSigned(metres: number) {
  return `${metres >= 0 ? "+" : "−"}${formatLength(Math.abs(metres))}`;
}

/** A tool's marker: always drawn on top, so it can't hide inside the cloud. */
export function markerPoint(Cesium: Cesium, color: string): CesiumType.PointGraphics.ConstructorOptions {
  return {
    pixelSize: 9,
    color: Cesium.Color.fromCssColorString(color),
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

/** A tool's text on the map, dark chip, always on top. */
export function markerLabel(Cesium: Cesium, text: string): CesiumType.LabelGraphics.ConstructorOptions {
  return {
    text,
    font: "600 13px sans-serif",
    fillColor: Cesium.Color.WHITE,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString("rgba(15, 23, 42, 0.85)"),
    backgroundPadding: new Cesium.Cartesian2(8, 5),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    pixelOffset: new Cesium.Cartesian2(0, -10),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}
