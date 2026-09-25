/**
 * Renders detected plants as batched 3D geometry on the globe.
 *
 * Entities are not an option here: the survey yields tens of thousands of
 * crowns, and one entity each would stall the browser. Instead every plant in a
 * class becomes a `GeometryInstance` in a single `Primitive`, which Cesium
 * builds on a worker and draws in one pass. One primitive per class, so each
 * tier can be toggled by flipping `show`.
 *
 * Ground heights are sampled from the terrain once. The globe draws at true
 * scale, so a sampled height is final and the geometry never needs rebuilding.
 */

type Cesium = typeof import("cesium");

export type VegetationClass = 3 | 4 | 5;

export const VEGETATION_TIERS: { cls: VegetationClass; label: string; css: string }[] = [
  { cls: 5, label: "High (trees)", css: "#2f6b3a" },
  { cls: 4, label: "Medium (shrubs)", css: "#5f9c50" },
  { cls: 3, label: "Low (ground cover)", css: "#96be6e" },
];

type Plant = {
  lon: number;
  lat: number;
  height: number;
  radius: number;
  cls: VegetationClass;
  /** Terrain height under the plant, unexaggerated. */
  ground: number;
};

export type VegetationHandle = {
  counts: Record<number, number>;
  total: number;
  setVisible: (cls: VegetationClass, show: boolean) => void;
  setShowAll: (show: boolean) => void;
  destroy: () => void;
  /** Centre of the plants, for framing the camera. */
  centre: { lon: number; lat: number };
};

/** Crown sits at the top of the plant; a trunk fills the gap beneath tall ones. */
function crownDepth(radius: number, height: number): number {
  return Math.min(radius * 1.3, height * 0.45);
}

export async function loadVegetation(
  Cesium: Cesium,
  viewer: {
    scene: { primitives: { add: (p: unknown) => unknown; remove: (p: unknown) => boolean } };
    terrainProvider: unknown;
  },
  url: string,
): Promise<VegetationHandle | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  const collection = (await response.json()) as {
    features: {
      geometry: { coordinates: [number, number] };
      properties: { height: number; radius: number; class: number };
    }[];
  };
  if (!collection.features?.length) return null;

  const plants: Plant[] = collection.features.map((f) => ({
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    height: f.properties.height,
    radius: f.properties.radius,
    cls: f.properties.class as VegetationClass,
    ground: 0,
  }));

  // One terrain query for the lot. Sampling per plant at draw time would mean
  // tens of thousands of round trips through the tile cache.
  const cartographics = plants.map((p) =>
    Cesium.Cartographic.fromDegrees(p.lon, p.lat),
  );
  try {
    const sampled = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider as never,
      cartographics,
    );
    let missed = 0;
    sampled.forEach((c, i) => {
      if (Number.isFinite(c.height)) plants[i].ground = c.height;
      else missed++;
    });
    // Heights here are ellipsoidal and the ground sits ~32 m up, so a plant left
    // at 0 is buried, not merely misplaced. Say so: silently sinking the whole
    // layer underground looks identical to it never having loaded.
    if (missed > plants.length / 2) {
      console.warn(
        `vegetation: terrain returned no height for ${missed}/${plants.length} ` +
          `plants; they will be placed on the ellipsoid, likely below ground.`,
      );
    }
  } catch (err) {
    console.warn("vegetation: terrain sampling failed, plants placed on the ellipsoid", err);
  }

  const byClass = new Map<VegetationClass, Plant[]>();
  for (const p of plants) {
    const list = byClass.get(p.cls);
    if (list) list.push(p);
    else byClass.set(p.cls, [p]);
  }

  const colourFor = (cls: VegetationClass) =>
    Cesium.Color.fromCssColorString(
      VEGETATION_TIERS.find((t) => t.cls === cls)?.css ?? "#4a8a4a",
    );

  const primitives = new Map<VegetationClass, unknown>();
  const visible = new Map<VegetationClass, boolean>();
  let allVisible = true;

  const build = () => {
    for (const [cls, list] of byClass) {
      const colour = colourFor(cls);
      const instances: unknown[] = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const vz = crownDepth(p.radius, p.height);
        const base = p.ground;
        // Deterministic jitter so a stand of trees is not uniformly flat-shaded.
        const shade = 0.85 + ((i * 2654435761) % 1000) / 1000 * 0.3;
        const tint = Cesium.Color.fromAlpha(
          new Cesium.Color(colour.red * shade, colour.green * shade, colour.blue * shade),
          1,
        );
        const crown = Cesium.Cartesian3.fromDegrees(
          p.lon, p.lat, base + p.height - vz,
        );
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.EllipsoidGeometry({
              radii: new Cesium.Cartesian3(p.radius, p.radius, vz),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
              // Coarse on purpose: at tens of thousands of instances the vertex
              // count is what costs, not the silhouette.
              slicePartitions: 8,
              stackPartitions: 5,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(crown),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(tint),
            },
          }),
        );
        // Only tall plants get a visible trunk; on a shrub it would be a spike.
        const trunk = p.height - 2 * vz;
        if (cls === 5 && trunk > 1.5) {
          instances.push(
            new Cesium.GeometryInstance({
              geometry: new Cesium.CylinderGeometry({
                length: trunk,
                topRadius: Math.max(0.12, p.radius * 0.08),
                bottomRadius: Math.max(0.16, p.radius * 0.11),
                vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                slices: 6,
              }),
              modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
                Cesium.Cartesian3.fromDegrees(p.lon, p.lat, base + trunk / 2),
              ),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                  Cesium.Color.fromCssColorString("#6b5741"),
                ),
              },
            }),
          );
        }
      }
      const primitive = new Cesium.Primitive({
        geometryInstances: instances as never,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: false }),
        // Built on a worker; the globe stays interactive while it compiles.
        asynchronous: true,
      });
      primitive.show = allVisible && (visible.get(cls) ?? true);
      viewer.scene.primitives.add(primitive);
      primitives.set(cls, primitive);
    }
  };

  const teardown = () => {
    for (const p of primitives.values()) viewer.scene.primitives.remove(p);
    primitives.clear();
  };

  build();

  const counts: Record<number, number> = {};
  for (const [cls, list] of byClass) counts[cls] = list.length;
  const centre = {
    lon: plants.reduce((a, p) => a + p.lon, 0) / plants.length,
    lat: plants.reduce((a, p) => a + p.lat, 0) / plants.length,
  };

  const applyShow = () => {
    for (const [cls, primitive] of primitives) {
      (primitive as { show: boolean }).show =
        allVisible && (visible.get(cls) ?? true);
    }
  };

  return {
    counts,
    total: plants.length,
    centre,
    setVisible(cls, show) {
      visible.set(cls, show);
      applyShow();
    },
    setShowAll(show) {
      allVisible = show;
      applyShow();
    },
    destroy: teardown,
  };
}
