import type * as CesiumType from "cesium";
import type { NodeData } from "@/lib/copc/types";
import type { Picked } from "./pick";

type Cesium = typeof CesiumType;

export const PROFILE_COLOR = "#22d3ee";
/** Chart series colours, validated as a pair for the light panel surface. */
export const SERIES = { points: "#2a78d6", terrain: "#eb6834" };

/** Most points the chart draws; beyond this it thins evenly, keeping the extremes. */
const MAX_CHART_POINTS = 40_000;
const TERRAIN_SAMPLES = 256;

export type ProfilePoint = {
  /** Horizontal distance from the first end along the line, metres. */
  d: number;
  /** Elevation exactly as stored in the point cloud. */
  z: number;
  /** Perpendicular distance from the line, metres (signed: + is to the right). */
  offset: number;
  cls: number;
};

export type Profile = {
  length: number;
  corridor: number;
  /** Points inside the corridor, possibly thinned for drawing. */
  points: ProfilePoint[];
  /** How many points fell inside the corridor before thinning. */
  pointsInCorridor: number;
  terrain: { d: number; z: number }[];
};

/**
 * The geometry of the profile line: a local east-north-up frame at the first
 * end, so distances along and across the line are plain metres.
 */
export class ProfileLine {
  readonly length: number;
  private readonly toLocal: CesiumType.Matrix4;
  private readonly ux: number;
  private readonly uy: number;
  private readonly scratch: CesiumType.Cartesian3;
  private readonly ca: CesiumType.Cartographic;
  private readonly cb: CesiumType.Cartographic;

  constructor(private readonly Cesium: Cesium, readonly a: Picked, readonly b: Picked) {
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(a.position);
    this.toLocal = Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4());
    const end = Cesium.Matrix4.multiplyByPoint(this.toLocal, b.position, new Cesium.Cartesian3());
    this.length = Math.hypot(end.x, end.y);
    this.ux = this.length ? end.x / this.length : 1;
    this.uy = this.length ? end.y / this.length : 0;
    this.scratch = new Cesium.Cartesian3();
    this.ca = Cesium.Cartographic.fromCartesian(a.position);
    this.cb = Cesium.Cartographic.fromCartesian(b.position);
  }

  /** [along, across] for a lon/lat/height, in metres. */
  project(lng: number, lat: number, h: number): [number, number] {
    const { Cesium, scratch } = this;
    Cesium.Cartesian3.fromDegrees(lng, lat, h, undefined, scratch);
    const p = Cesium.Matrix4.multiplyByPoint(this.toLocal, scratch, scratch);
    return [p.x * this.ux + p.y * this.uy, p.x * this.uy - p.y * this.ux];
  }

  /** Lon/lat (radians) at a fraction of the way along, on the ellipsoid. */
  at(fraction: number): CesiumType.Cartographic {
    const { Cesium, ca, cb } = this;
    return new Cesium.Cartographic(
      ca.longitude + (cb.longitude - ca.longitude) * fraction,
      ca.latitude + (cb.latitude - ca.latitude) * fraction,
      0,
    );
  }

  /** Degree box around the line, padded by `pad` metres, for a cheap prefilter. */
  bounds(pad: number): [number, number, number, number] {
    const { Cesium, ca, cb } = this;
    const deg = Cesium.Math.toDegrees;
    const lat = (ca.latitude + cb.latitude) / 2;
    const dLat = pad / 111_000;
    const dLng = pad / (111_000 * Math.max(0.01, Math.cos(lat)));
    return [
      Math.min(deg(ca.longitude), deg(cb.longitude)) - dLng,
      Math.min(deg(ca.latitude), deg(cb.latitude)) - dLat,
      Math.max(deg(ca.longitude), deg(cb.longitude)) + dLng,
      Math.max(deg(ca.latitude), deg(cb.latitude)) + dLat,
    ];
  }
}

/** Every resident point within `corridor / 2` of the line, as drawn on the globe. */
export function pointsInCorridor(
  line: ProfileLine,
  nodes: Iterable<NodeData>,
  corridor: number,
  hidden: ReadonlySet<number>,
): { points: ProfilePoint[]; total: number } {
  const half = corridor / 2;
  const [w, s, e, n] = line.bounds(half + 1);
  const all: ProfilePoint[] = [];

  for (const node of nodes) {
    const pos = node.positions;
    for (let i = 0; i < node.pointCount; i++) {
      const lng = pos[i * 3];
      const lat = pos[i * 3 + 1];
      if (lng < w || lng > e || lat < s || lat > n) continue;
      const cls = node.classifications[i];
      if (hidden.has(cls)) continue;
      const z = pos[i * 3 + 2];
      const [d, offset] = line.project(lng, lat, z);
      if (d < 0 || d > line.length || Math.abs(offset) > half) continue;
      all.push({ d, z, offset, cls });
    }
  }

  if (all.length <= MAX_CHART_POINTS) return { points: all, total: all.length };

  // Thin evenly along the line, but never lose the highest and lowest points.
  all.sort((p, q) => p.d - q.d);
  const step = all.length / MAX_CHART_POINTS;
  const kept: ProfilePoint[] = [];
  for (let k = 0; k < all.length; k += step) kept.push(all[Math.floor(k)]);
  let lo = all[0], hi = all[0];
  for (const p of all) {
    if (p.z < lo.z) lo = p;
    if (p.z > hi.z) hi = p;
  }
  kept.push(lo, hi);
  return { points: kept, total: all.length };
}

/** The terrain surface along the line, at its most detailed level. */
export async function terrainAlong(
  Cesium: Cesium,
  terrainProvider: CesiumType.TerrainProvider,
  line: ProfileLine,
): Promise<{ d: number; z: number }[]> {
  // A plain ellipsoid is height zero everywhere: no surface worth plotting.
  if (terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return [];
  const fractions = Array.from({ length: TERRAIN_SAMPLES + 1 }, (_, i) => i / TERRAIN_SAMPLES);
  try {
    const sampled = await Cesium.sampleTerrainMostDetailed(
      terrainProvider, fractions.map((f) => line.at(f)));
    return sampled.flatMap((c, i) =>
      Number.isFinite(c.height) ? [{ d: fractions[i] * line.length, z: c.height }] : []);
  } catch {
    return [];
  }
}
