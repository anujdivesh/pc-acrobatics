import type * as CesiumType from "cesium";
import { loadVegetation, type VegetationClass, type VegetationHandle } from "./vegetation";
import { lonLatBounds, type OrthoMeta, type TerrainMeta } from "./types";

type Cesium = typeof CesiumType;

export type TerrainUrls = {
  terrain: string;
  meta: string;
  ortho?: string;
  orthoMeta?: string;
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
  destroy: () => void;
};

/**
 * Swaps the globe onto the survey's own quantized-mesh terrain and drapes the
 * survey products over it: orthophoto, extruded buildings, detected plants.
 *
 * Everything is additive and reversible — `destroy` puts the previous terrain
 * provider back — so the layer can be switched off without rebuilding the viewer.
 */
export async function loadTerrainLayer(
  Cesium: Cesium,
  viewer: CesiumType.Viewer,
  urls: TerrainUrls,
): Promise<TerrainLayerHandle> {
  const meta: TerrainMeta = await (await fetch(urls.meta)).json();
  const ortho: OrthoMeta | undefined = urls.orthoMeta
    ? await fetch(urls.orthoMeta).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)
    : undefined;

  const previousTerrain = viewer.terrainProvider;
  const previousExaggeration = viewer.scene.verticalExaggeration;
  const terrain = await Cesium.CesiumTerrainProvider.fromUrl(urls.terrain);
  viewer.terrainProvider = terrain;

  // Not 1, and not cosmetic. With this tileset and verticalExaggeration at
  // exactly 1, Cesium's quadtree selects zero tiles and reports itself loaded:
  // the surface never draws, with no error and no failed request. Measured here
  // as 0 tiles at 1 and 24 at 1.000001, and independently in the sibling project
  // before this one existed. Cesium's own World Terrain is fine at 1, so it is
  // something about these tiles; until that is found, this offset is one part in
  // a million -- a hundredth of a millimetre on the tallest thing in the survey
  // -- so the terrain is still 1:1 to any measurable digit.
  viewer.scene.verticalExaggeration = 1.000001;

  const bounds = lonLatBounds(meta.bounds3857);
  const [w, s, e, n] = bounds;

  // --- orthophoto -------------------------------------------------------
  let imagery: CesiumType.ImageryLayer | null = null;
  if (urls.ortho) {
    imagery = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: `${urls.ortho}/{z}/{x}/{y}.${ortho?.format ?? "png"}`,
        // 512 px tiles; Cesium assumes 256 and would ask for four times as many.
        tileWidth: ortho?.tileSize ?? 512,
        tileHeight: ortho?.tileSize ?? 512,
        minimumLevel: ortho?.minzoom ?? meta.minzoom,
        maximumLevel: ortho?.maxzoom ?? meta.maxzoom,
        // Its own extent, not the terrain's: the imagery covers less ground, and
        // using the wider one makes Cesium 404 around the edges.
        rectangle: Cesium.Rectangle.fromDegrees(...lonLatBounds(ortho?.bounds3857 ?? meta.bounds3857)),
        credit: "LiDAR orthophoto",
      }),
    );
    viewer.imageryLayers.raiseToTop(imagery);
  }

  // --- buildings --------------------------------------------------------
  let buildings: CesiumType.GeoJsonDataSource | null = null;
  if (urls.buildings) {
    try {
      buildings = await Cesium.GeoJsonDataSource.load(urls.buildings, { clampToGround: false });
      for (const entity of buildings.entities.values) {
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
      await viewer.dataSources.add(buildings);
    } catch {
      buildings = null;
    }
  }

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

  // --- vegetation -------------------------------------------------------
  // Last, and only after the terrain answers: every plant is placed on a height
  // sampled from the mesh, and tens of thousands of samples compete with the
  // globe's own tile queue.
  let vegetation: VegetationHandle | null = null;
  if (urls.vegetation) {
    try {
      vegetation = await loadVegetation(Cesium, viewer as never, urls.vegetation);
    } catch {
      vegetation = null;
    }
  }

  return {
    meta,
    ortho,
    sampleHeight,
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
    destroy() {
      vegetation?.destroy();
      if (buildings) viewer.dataSources.remove(buildings, true);
      if (imagery) viewer.imageryLayers.remove(imagery, true);
      viewer.terrainProvider = previousTerrain;
      viewer.scene.verticalExaggeration = previousExaggeration;
    },
  };
}
