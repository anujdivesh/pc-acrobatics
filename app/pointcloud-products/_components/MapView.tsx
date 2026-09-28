"use client";

import { useEffect, useRef, useState } from "react";
import type * as CesiumType from "cesium";
import { loadCesium, type Cesium } from "@/lib/cesium/loadCesium";
import { openPmtilesImagery } from "@/lib/terrain/pmtilesImagery";
import type { MapLayers, Overlay, Vector } from "./types";

type Props = {
  bounds: [number, number, number, number] | null;
  layers: MapLayers;
  showOrtho: boolean;
};

type VectorHandle = { show: (on: boolean) => void };

/** Cesium layers are mutable objects; visibility is set through this. */
function setShown(layer: { show: boolean }, on: boolean) {
  layer.show = on;
}

/**
 * A flat, top-down map of the survey with the product layers on it.
 *
 * Flat on purpose: the products are 2D rasters and lines, and on the plain
 * ellipsoid every overlay, line and point sits exactly where it was computed,
 * with no draping or clamping. Layers are created on first use and then only
 * shown or hidden, so switching products is instant.
 */
export default function MapView({ bounds, layers, showOrtho }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<{ C: Cesium; viewer: CesiumType.Viewer } | null>(null);
  const overlaysRef = useRef(new Map<string, CesiumType.ImageryLayer>());
  const vectorsRef = useRef(new Map<string, Promise<VectorHandle>>());
  const orthoRef = useRef<CesiumType.ImageryLayer | null>(null);

  useEffect(() => {
    let viewer: CesiumType.Viewer | undefined;
    let cancelled = false;
    const overlays = overlaysRef.current;
    const vectors = vectorsRef.current;
    loadCesium().then(async (C) => {
      if (cancelled || !containerRef.current) return;
      C.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";
      viewer = new C.Viewer(containerRef.current, {
        baseLayer: C.ImageryLayer.fromProviderAsync(
          C.createWorldImageryAsync({ style: C.IonWorldImageryStyle.AERIAL })),
        terrainProvider: new C.EllipsoidTerrainProvider(),
        baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
        navigationHelpButton: false, fullscreenButton: false, timeline: false, animation: false,
        infoBox: false, selectionIndicator: false,
      });
      viewer.scene.globe.depthTestAgainstTerrain = false;
      const ortho = await openPmtilesImagery(C, "/tonga/ortho.pmtiles", "LiDAR orthophoto").catch(() => null);
      if (cancelled || viewer.isDestroyed()) return;
      if (ortho) orthoRef.current = viewer.imageryLayers.addImageryProvider(ortho.provider);

      setMap({ C, viewer });
    }).catch(console.error);
    return () => {
      cancelled = true;
      overlays.clear();
      vectors.clear();
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  // Frame the survey once.
  const framed = useRef(false);
  useEffect(() => {
    if (!map || !bounds || framed.current) return;
    framed.current = true;
    const [w, s, e, n] = bounds;
    map.viewer.camera.setView({ destination: map.C.Rectangle.fromDegrees(w, s, e, n) });
  }, [map, bounds]);

  useEffect(() => {
    if (orthoRef.current) setShown(orthoRef.current, showOrtho);
  }, [map, showOrtho]);

  // Raster overlays: create on first use, then just show/hide.
  useEffect(() => {
    if (!map) return;
    const { C, viewer } = map;
    const wanted = new Set(layers.overlays.map((o) => o.id));
    for (const [id, layer] of overlaysRef.current) setShown(layer, wanted.has(id));
    layers.overlays.forEach((o: Overlay) => {
      let layer = overlaysRef.current.get(o.id);
      if (!layer) {
        const [w, s, e, n] = o.rect;
        layer = C.ImageryLayer.fromProviderAsync(
          C.SingleTileImageryProvider.fromUrl(o.url, { rectangle: C.Rectangle.fromDegrees(w, s, e, n) }), {});
        viewer.imageryLayers.add(layer);
        overlaysRef.current.set(o.id, layer);
      }
      setShown(layer, true);
      viewer.imageryLayers.raiseToTop(layer);
    });
  }, [map, layers.overlays]);

  // Vector layers: GeoJSON lines and polygons as data sources; points (trees,
  // tens of thousands) as one point primitive collection, which stays fast.
  useEffect(() => {
    if (!map) return;
    const { C, viewer } = map;
    const wanted = new Set(layers.vectors.map((v) => v.id));
    for (const [id, handle] of vectorsRef.current) handle.then((h) => h.show(wanted.has(id)));
    layers.vectors.forEach((v: Vector) => {
      if (vectorsRef.current.has(v.id)) return;
      vectorsRef.current.set(v.id, loadVector(C, viewer, v));
    });
  }, [map, layers.vectors]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

async function loadVector(C: Cesium, viewer: CesiumType.Viewer, v: Vector): Promise<VectorHandle> {
  const fc = await (await fetch(v.url)).json();
  if (v.style.point) {
    const points = viewer.scene.primitives.add(new C.PointPrimitiveCollection()) as CesiumType.PointPrimitiveCollection;
    const color = C.Color.fromCssColorString(v.style.point);
    for (const f of fc.features) {
      const [lon, lat] = f.geometry.coordinates;
      points.add({ position: C.Cartesian3.fromDegrees(lon, lat), pixelSize: v.style.size ?? 3, color,
        outlineColor: C.Color.WHITE.withAlpha(0.6), outlineWidth: 0.5 });
    }
    return { show: (on) => setShown(points, on) };
  }
  const source = await C.GeoJsonDataSource.load(fc, {
    stroke: C.Color.fromCssColorString(v.style.stroke ?? "#111827"),
    strokeWidth: v.style.width ?? 1.5,
    fill: v.style.fill ? C.Color.fromCssColorString(v.style.fill).withAlpha(0.45) : C.Color.TRANSPARENT,
  });
  await viewer.dataSources.add(source);
  return { show: (on) => setShown(source, on) };
}
