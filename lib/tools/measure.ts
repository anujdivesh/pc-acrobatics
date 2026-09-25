import type * as CesiumType from "cesium";
import { formatLength, formatSigned, markerLabel, type Picked, type PickSource } from "./pick";
import type { TwoPointPicker } from "./twoPoint";

type Cesium = typeof CesiumType;

export type Measurement = {
  /** Straight-line distance between the two points, in metres. */
  distance: number;
  /** Distance along the ellipsoid surface, ignoring height. */
  horizontal: number;
  /** Height of the second point above the first. */
  vertical: number;
  from: PickSource;
  to: PickSource;
};

export const MEASURE_COLOR = "#facc15";

export function measure(Cesium: Cesium, a: Picked, b: Picked): Measurement {
  const ca = Cesium.Cartographic.fromCartesian(a.position);
  const cb = Cesium.Cartographic.fromCartesian(b.position);
  // Same spot: the geodesic is undefined, and there is nothing to measure.
  const horizontal = Cesium.Cartesian3.equalsEpsilon(a.position, b.position, 0, 1e-6)
    ? 0
    : new Cesium.EllipsoidGeodesic(ca, cb).surfaceDistance;
  return {
    distance: Cesium.Cartesian3.distance(a.position, b.position),
    horizontal,
    vertical: cb.height - ca.height,
    from: a.source,
    to: b.source,
  };
}

/** The measured segment and its label, owned by the picker so a clear removes them. */
export function drawMeasurement(
  Cesium: Cesium, picker: TwoPointPicker, a: Picked, b: Picked, m: Measurement,
) {
  const color = Cesium.Color.fromCssColorString(MEASURE_COLOR);
  picker.addEntity({
    polyline: {
      positions: [a.position, b.position],
      width: 3,
      arcType: Cesium.ArcType.NONE,
      material: color,
      // Keep the segment readable where it passes behind terrain or points.
      depthFailMaterial: color.withAlpha(0.45),
    },
  });
  picker.addEntity({
    position: Cesium.Cartesian3.midpoint(a.position, b.position, new Cesium.Cartesian3()),
    label: markerLabel(Cesium, `${formatLength(m.distance)}\nΔh ${formatSigned(m.vertical)}`),
  });
}
