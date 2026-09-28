import type * as CesiumType from "cesium";
import { PMTiles } from "pmtiles";
import type { TerrainMeta } from "./types";

type Cesium = typeof CesiumType;

type LayerRange = { startX: number; startY: number; endX: number; endY: number };

/** What scripts/build_cesium_terrain.py stores in the archive's metadata. */
type Metadata = {
  scheme: string;
  /** Geographic tiles are stored this many zooms deeper, so their x/y fit PMTiles numbering. */
  zoomOffset: number;
  layer: { available: LayerRange[][] };
  terrainMeta: TerrainMeta;
};

/**
 * Cesium terrain from quantized-mesh tiles packed in one PMTiles archive.
 *
 * Does what CesiumTerrainProvider does for a layer.json + {z}/{x}/{y}.terrain
 * tree -- availability from `available`, each tile decoded into
 * QuantizedMeshTerrainData -- but reads the tiles as byte ranges of a single
 * file instead of tens of thousands of separate requests' worth of files.
 */
export async function openPmtilesTerrain(
  Cesium: Cesium,
  url: string,
): Promise<{ provider: CesiumType.TerrainProvider; meta: TerrainMeta }> {
  const archive = new PMTiles(url);
  const md = (await archive.getMetadata()) as Metadata;
  if (md.scheme !== "cesium-geographic-tms" || !md.layer?.available) {
    throw new Error(`${url}: not a quantized-mesh terrain archive`);
  }
  const offset = md.zoomOffset ?? 1;

  const tilingScheme = new Cesium.GeographicTilingScheme();
  const levels = md.layer.available.length;
  const availability = new Cesium.TileAvailability(tilingScheme, levels);
  md.layer.available.forEach((ranges, level) => {
    // layer.json counts rows up from the south (TMS); Cesium counts down from the north.
    const rows = tilingScheme.getNumberOfYTilesAtLevel(level);
    for (const r of ranges) {
      availability.addAvailableTileRange(level, r.startX, rows - r.endY - 1, r.endX, rows - r.startY - 1);
    }
  });

  // Same geometric-error model CesiumTerrainProvider uses for 65-post tiles.
  const levelZeroError = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
    tilingScheme.ellipsoid, 65, tilingScheme.getNumberOfXTilesAtLevel(0));
  const levelError = (level: number) => levelZeroError / (1 << level);

  const childMask = (x: number, y: number, level: number) => {
    const l = level + 1;
    return (availability.isTileAvailable(l, 2 * x, 2 * y + 1) ? 1 : 0)       // south-west
      | (availability.isTileAvailable(l, 2 * x + 1, 2 * y + 1) ? 2 : 0)      // south-east
      | (availability.isTileAvailable(l, 2 * x, 2 * y) ? 4 : 0)              // north-west
      | (availability.isTileAvailable(l, 2 * x + 1, 2 * y) ? 8 : 0);         // north-east
  };

  const decode = (buffer: ArrayBuffer, x: number, y: number, level: number) => {
    const view = new DataView(buffer);
    const f64 = (o: number) => view.getFloat64(o, true);
    const minimumHeight = view.getFloat32(24, true);
    const maximumHeight = view.getFloat32(28, true);
    const boundingSphere = new Cesium.BoundingSphere(
      new Cesium.Cartesian3(f64(32), f64(40), f64(48)), f64(56));
    const horizonOcclusionPoint = new Cesium.Cartesian3(f64(64), f64(72), f64(80));
    let pos = 88;

    const vertexCount = view.getUint32(pos, true);
    pos += 4;
    const quantizedVertices = new Uint16Array(buffer, pos, vertexCount * 3);
    pos += vertexCount * 6;
    // u, v and height are each zigzag-encoded deltas from the previous vertex.
    for (let band = 0; band < 3; band++) {
      let value = 0;
      for (let i = band * vertexCount, end = i + vertexCount; i < end; i++) {
        const zz = quantizedVertices[i];
        value += (zz >> 1) ^ -(zz & 1);
        quantizedVertices[i] = value;
      }
    }

    const bytesPerIndex = vertexCount > 65536 ? 4 : 2;
    const indexArray = (at: number, count: number) =>
      bytesPerIndex === 4 ? new Uint32Array(buffer, at, count) : new Uint16Array(buffer, at, count);
    if (pos % bytesPerIndex) pos += bytesPerIndex - (pos % bytesPerIndex);
    const triangleCount = view.getUint32(pos, true);
    pos += 4;
    const indices = indexArray(pos, triangleCount * 3);
    pos += triangleCount * 3 * bytesPerIndex;
    // High-water-mark decoding.
    for (let i = 0, highest = 0; i < indices.length; i++) {
      const code = indices[i];
      indices[i] = highest - code;
      if (code === 0) highest++;
    }

    const edge = () => {
      const count = view.getUint32(pos, true);
      pos += 4;
      const list = indexArray(pos, count);
      pos += count * bytesPerIndex;
      return list;
    };
    const westIndices = edge();
    const southIndices = edge();
    const eastIndices = edge();
    const northIndices = edge();

    const skirt = levelError(level) * 5;
    return new Cesium.QuantizedMeshTerrainData({
      minimumHeight,
      maximumHeight,
      quantizedVertices,
      indices,
      boundingSphere,
      orientedBoundingBox: Cesium.OrientedBoundingBox.fromRectangle(
        tilingScheme.tileXYToRectangle(x, y, level), minimumHeight, maximumHeight, tilingScheme.ellipsoid),
      horizonOcclusionPoint,
      // Typed as number[], but Cesium's own loader passes typed arrays here too.
      westIndices: westIndices as unknown as number[],
      southIndices: southIndices as unknown as number[],
      eastIndices: eastIndices as unknown as number[],
      northIndices: northIndices as unknown as number[],
      westSkirtHeight: skirt,
      southSkirtHeight: skirt,
      eastSkirtHeight: skirt,
      northSkirtHeight: skirt,
      childTileMask: childMask(x, y, level),
    });
  };

  const provider = {
    tilingScheme,
    availability,
    hasWaterMask: false,
    hasVertexNormals: false,
    errorEvent: new Cesium.Event(),
    credit: new Cesium.Credit("LiDAR terrain"),
    getLevelMaximumGeometricError: levelError,
    getTileDataAvailable: (x: number, y: number, level: number) =>
      availability.isTileAvailable(level, x, y),
    loadTileDataAvailability: () => undefined,
    async requestTileGeometry(x: number, y: number, level: number) {
      const rows = tilingScheme.getNumberOfYTilesAtLevel(level);
      const tile = await archive.getZxy(level + offset, x, rows - y - 1);
      if (!tile) throw new Error(`terrain tile ${level}/${x}/${y} missing from archive`);
      return decode(tile.data, x, y, level);
    },
  };
  return { provider: provider as unknown as CesiumType.TerrainProvider, meta: md.terrainMeta };
}
