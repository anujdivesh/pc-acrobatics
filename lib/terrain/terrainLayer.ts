import type * as CesiumType from "cesium";
import { loadVegetation, type VegetationClass, type VegetationHandle } from "./vegetation";
import { openPmtilesImagery } from "./pmtilesImagery";
import { openPmtilesTerrain } from "./pmtilesTerrain";
import { createRelief, type ReliefSettings } from "./relief";
import { lonLatBounds, type OrthoMeta, type TerrainMeta } from "./types";

type Cesium = typeof CesiumType;

export type TerrainUrls = {
  /** Quantized-mesh PMTiles archive (scripts/build_cesium_terrain.py); carries its own metadata. */
  terrain: string;
  /** Raster PMTiles archive (scripts/build_ortho_pmtiles.py). */
  ortho?: string;
  buildings?: string;
  vegetation?: string;
};

export type TerrainLayerHandle = {
  meta: TerrainMeta;
  ortho?: OrthoMeta;
  sampleHeight?: number;
  buildingCount: number;
  vegetationCounts: Record<number, number>;
  bounds: [number, number, number, number];
  setOrtho: (show: boolean, alpha: number) => void;
  setBuildings: (show: boolean) => void;
  setVegetation: (show: boolean, tiers: Record<VegetationClass, boolean>) => void;
  setRelief: (settings: ReliefSettings) => void;
  /** Height the relief colours and contours count from: the measured water level. */
  seaLevel: number;
  destroy: () => void;
};

export type TerrainLayerOptions = {
  /** What to put back when the layer goes: the viewer's own base terrain. */
  baseTerrain: CesiumType.TerrainProvider;
  /** Aborted when the layer is switched off while it is still loading. */
  signal: AbortSignal;
};

const aborted = () => new DOMException("terrain layer load cancelled", "AbortError");

/**
 * Swaps the globe onto the survey's own quantized-mesh terrain and drapes the
 * survey products over it: orthophoto, extruded buildings, detected plants.
 *
 * Everything is additive and reversible. Loads can overlap -- the layer switched
 * off and on again quickly, or React mounting effects twice in development -- so
 * a cancelled load undoes whatever it had added and stops, and removal restores
 * the viewer's base terrain (never "whatever was there when I started", which
 * may be another load's) and only if this layer's terrain is still the one shown.
 */
export async function loadTerrainLayer(
  Cesium: Cesium,
  viewer: CesiumType.Viewer,
  urls: TerrainUrls,
  { baseTerrain, signal }: TerrainLayerOptions,
): Promise<TerrainLayerHandle> {
  const { provider: terrain, meta } = await openPmtilesTerrain(Cesium, urls.terrain);
  // The archive describes itself: zoom range, tile size and extent live in its
  // header and metadata. A missing or broken archive just means no drape.
  const orthoSource = urls.ortho
    ? await openPmtilesImagery(Cesium, urls.ortho, "LiDAR orthophoto").catch((err) => {
        console.warn("orthophoto unavailable:", err);
        return undefined;
      })
    : undefined;
  const ortho: OrthoMeta | undefined = orthoSource?.meta;
  // Nothing has touched the viewer yet, so a cancel here needs no undoing.
  if (signal.aborted || viewer.isDestroyed()) throw aborted();

  let imagery: CesiumType.ImageryLayer | null = null;
  let buildings: CesiumType.GeoJsonDataSource | null = null;
  let vegetation: VegetationHandle | null = null;
  let relief: ReturnType<typeof createRelief> | null = null;

  /** Remove whatever this layer has added so far. Safe to call at any point. */
  const teardown = () => {
    // On unmount the viewer can go first, taking everything below with it.
    if (viewer.isDestroyed()) return;
    const steps = [
      () => relief?.destroy(),
      () => vegetation?.destroy(),
      () => buildings && viewer.dataSources.remove(buildings, true),
      () => imagery && viewer.imageryLayers.remove(imagery, true),
      () => {
        if (viewer.terrainProvider === terrain) {
          viewer.terrainProvider = baseTerrain;
          viewer.scene.verticalExaggeration = 1;
        }
      },
    ];
    // One failing step must not leave the rest -- above all the terrain -- behind.
    for (const step of steps) {
      try {
        step();
      } catch (err) {
        console.warn("terrain layer cleanup:", err);
      }
    }
    relief = vegetation = buildings = imagery = null;
  };
  const checkpoint = () => {
    if (!signal.aborted && !viewer.isDestroyed()) return;
    teardown();
    throw aborted();
  };

  try {
    return await install();
  } catch (err) {
    // Whatever failed, leave nothing behind: a half-installed layer would keep
    // its terrain on the globe with no handle left to remove it.
    teardown();
    throw err;
  }

  async function install(): Promise<TerrainLayerHandle> {
    viewer.terrainProvider = terrain;

    // True scale: heights are the survey's own, drawn 1:1. (The previous tileset
    // only drew at 1.000001: its coarse tiles were simplified on height alone,
    // collapsed to flat quads through the planet, and failed Cesium's horizon
    // culling at exactly 1. scripts/build_cesium_terrain.py fixes that at source.)
    viewer.scene.verticalExaggeration = 1;

    const bounds = lonLatBounds(meta.bounds3857);
    const [w, s, e, n] = bounds;

    // --- orthophoto -------------------------------------------------------
    if (orthoSource) {
      imagery = viewer.imageryLayers.addImageryProvider(orthoSource.provider);
      viewer.imageryLayers.raiseToTop(imagery);
    }

    // --- buildings --------------------------------------------------------
    if (urls.buildings) {
      try {
        const source = await Cesium.GeoJsonDataSource.load(urls.buildings, { clampToGround: false });
        checkpoint();
        for (const entity of source.entities.values) {
          const height = Number(
            entity.properties?.height?.getValue?.(Cesium.JulianDate.now()) ?? 0);
          if (!entity.polygon || !height) continue;
          entity.polygon.material = new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString("#e8ddc8"));
          entity.polygon.outline = new Cesium.ConstantProperty(true);
          entity.polygon.outlineColor = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString("#6b6252"));
          // Base on the terrain, roof raised by the measured height.
          entity.polygon.perPositionHeight = new Cesium.ConstantProperty(false);
          entity.polygon.heightReference = new Cesium.ConstantProperty(
            Cesium.HeightReference.CLAMP_TO_GROUND);
          entity.polygon.extrudedHeightReference = new Cesium.ConstantProperty(
            Cesium.HeightReference.RELATIVE_TO_GROUND);
          entity.polygon.extrudedHeight = new Cesium.ConstantProperty(height);
        }
        buildings = source;
        await viewer.dataSources.add(source);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        buildings = null;
      }
    }
    checkpoint();

    // --- terrain proof ----------------------------------------------------
    // Sample the mesh rather than assume it loaded; a blank globe and a flat one
    // look identical from the outside.
    let sampleHeight: number | undefined;
    try {
      const centre = Cesium.Cartographic.fromDegrees((w + e) / 2, (s + n) / 2);
      const [sampled] = await Cesium.sampleTerrainMostDetailed(terrain, [centre]);
      sampleHeight = sampled?.height;
    } catch {
      sampleHeight = undefined;
    }
    checkpoint();

    // --- vegetation -------------------------------------------------------
    // Last, and only after the terrain answers: every plant is placed on a height
    // sampled from the mesh, and tens of thousands of samples compete with the
    // globe's own tile queue.
    if (urls.vegetation) {
      try {
        vegetation = await loadVegetation(Cesium, viewer as never, urls.vegetation);
      } catch {
        vegetation = null;
      }
    }
    checkpoint();

    // --- depth / elevation relief ----------------------------------------
    // Counted from the water surface the survey measured; the archive's own median
    // only stands in if an older archive predates that field.
    const seaLevel = meta.waterLevel ?? meta.elevation.median;
    relief = createRelief(Cesium, viewer, seaLevel, Cesium.Rectangle.fromDegrees(w, s, e, n));
    const reliefHandle = relief;

    return {
      meta,
      ortho,
      sampleHeight,
      seaLevel,
      bounds,
      buildingCount: buildings?.entities.values.length ?? 0,
      vegetationCounts: vegetation?.counts ?? {},
      setOrtho(show, alpha) {
        if (!imagery) return;
        imagery.show = show;
        imagery.alpha = alpha;
      },
      setBuildings(show) {
        if (buildings) buildings.show = show;
      },
      setVegetation(show, tiers) {
        if (!vegetation) return;
        vegetation.setShowAll(show);
        for (const [cls, on] of Object.entries(tiers)) {
          vegetation.setVisible(Number(cls) as VegetationClass, on);
        }
      },
      setRelief(settings) {
        reliefHandle.update(settings);
      },
      destroy: teardown,
    };
  }
}
