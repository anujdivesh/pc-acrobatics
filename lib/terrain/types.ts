/** Written by scripts/build_terrain_tiles.py beside the tiles. */
export type TerrainMeta = {
  minzoom: number;
  maxzoom: number;
  resolution: number;
  /** Median Z of water-surface returns. Heights here are ellipsoidal, so this
   *  is around 32 m, not 0. */
  waterLevel: number;
  elevation: { min: number; max: number; mean: number; median: number };
  bounds3857: [number, number, number, number];
};

/** Written by scripts/write_ortho_meta.py beside the imagery tiles. */
export type OrthoMeta = {
  minzoom: number;
  maxzoom: number;
  tileSize: number;
  format: string;
  tiles: number;
  bounds3857: [number, number, number, number];
  sourceResolution: number;
};

const MERCATOR_HALF = 20037508.342789244;

/** Web Mercator extent as [west, south, east, north] degrees. */
export function lonLatBounds(
  bounds3857: readonly number[],
): [number, number, number, number] {
  const lon = (x: number) => (x / MERCATOR_HALF) * 180;
  const lat = (y: number) =>
    (Math.atan(Math.exp((y / MERCATOR_HALF) * Math.PI)) * 360) / Math.PI - 90;
  const [w, s, e, n] = bounds3857;
  return [lon(w), lat(s), lon(e), lat(n)];
}
