"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type * as CesiumType from "cesium";
import { useCopcSource } from "@/lib/copc/useCopcSource";
import { PointCloudRenderer } from "@/lib/copc/cesiumPoints";
import { usePointCloud } from "./PointCloudProvider";
import { useTerrainLayer } from "./TerrainProvider";
import { useMap } from "./MapProvider";
import { loadTerrainLayer, type TerrainLayerHandle } from "@/lib/terrain/terrainLayer";
import { lonLatBounds } from "@/lib/terrain/types";
import { loadCesium, type Cesium } from "@/lib/cesium/loadCesium";

const COPC_URL = "/tonga/topobathy.copc.laz";
const TERRAIN_URLS = {
  terrain: "/tonga/terrain.pmtiles",
  ortho: "/tonga/ortho.pmtiles",
  buildings: "/tonga/buildings.geojson",
  vegetation: "/tonga/vegetation.geojson",
};

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cesium, setCesium] = useState<Cesium | null>(null);
  const [viewer, setViewer] = useState<CesiumType.Viewer | null>(null);
  const { settings, setStatus, registerZoom, registerNodes } = usePointCloud();
  const {
    settings: terrainSettings,
    status: terrainStatus,
    setStatus: setTerrainStatus,
    registerZoom: registerTerrainZoom,
  } = useTerrainLayer();

  // The worker only runs while the layer is on.
  const { nodes, status, setView } = useCopcSource(settings.enabled ? COPC_URL : "");
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  // The globe's own terrain, which every overlay layer restores when it goes.
  const baseTerrainRef = useRef<CesiumType.TerrainProvider | null>(null);
  const { setMap } = useMap();

  useEffect(() => {
    let created: CesiumType.Viewer | undefined;
    let cancelled = false;

    loadCesium().then(async (Cesium) => {
      if (cancelled || !containerRef.current) return;

      Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";

      // Resolved before the viewer exists, not handed over as a pending
      // `Terrain`: that assigns the provider whenever it finishes loading, which
      // can land after the Tonga terrain layer is switched on and silently
      // replace it with world terrain.
      const worldTerrain = await Cesium.createWorldTerrainAsync()
        .catch(() => new Cesium.EllipsoidTerrainProvider());
      if (cancelled || !containerRef.current) return;
      baseTerrainRef.current = worldTerrain;

      created = new Cesium.Viewer(containerRef.current, {
        // Bing Maps aerial with labels, served through Cesium ion.
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(
          Cesium.createWorldImageryAsync({
            style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
          }),
        ),
        terrainProvider: worldTerrain,
        // Cesium's own widgets are replaced by the app's tools and navigation
        // controls. The credit line stays: Cesium ion and Bing require it.
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        timeline: false,
        animation: false,
      });
      setCesium(Cesium);
      setViewer(created);
    }).catch(console.error);

    return () => {
      cancelled = true;
      if (created && !created.isDestroyed()) created.destroy();
    };
  }, []);

  // Share the viewer with UI that lives outside the globe, such as the tools.
  useEffect(() => {
    if (!cesium || !viewer) return;
    setMap({ cesium, viewer });
    return () => setMap(null);
  }, [cesium, viewer, setMap]);

  // --- point cloud ------------------------------------------------------
  const hidden = useMemo(() => new Set(settings.hidden), [settings.hidden]);

  useEffect(() => {
    if (!cesium || !viewer || !settings.enabled) return;
    const renderer = new PointCloudRenderer(cesium, viewer.scene, settings.pointSize);
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = null;
      renderer.destroy();
    };
    // Colour mode and the class filter change what every point looks like, so
    // the cloud is rebuilt from scratch rather than patched in place.
  }, [cesium, viewer, settings.enabled, settings.colorMode, hidden, settings.pointSize]);

  // Resident nodes -> points on the globe. The renderer drops and rebuilds by
  // itself if the ramp range changes under it.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !status.metadata) return;
    renderer.setElevationRange(...(status.rampRange ?? status.metadata.zRange));
    for (const [key, node] of nodes) {
      if (!renderer.has(key)) renderer.add(node, settings.colorMode, hidden);
    }
    for (const key of renderer.keys()) {
      if (!nodes.has(key)) renderer.drop(key);
    }
  }, [nodes, status.metadata, status.rampRange, settings.colorMode, hidden]);

  // What the profile tool reads: exactly the points resident on the globe.
  useEffect(() => {
    registerNodes(() => nodes.values());
    return () => registerNodes(null);
  }, [nodes, registerNodes]);

  // Class counts for the filter list, sampled rather than counted in full:
  // an exact tally would walk every resident point on every node arrival.
  const histogram = useMemo(() => {
    const h: Record<number, number> = {};
    for (const node of nodes.values()) {
      for (let i = 0; i < node.pointCount; i += 8) {
        const c = node.classifications[i];
        h[c] = (h[c] ?? 0) + 8;
      }
    }
    return h;
  }, [nodes]);

  useEffect(() => {
    setStatus({
      metadata: status.metadata,
      error: status.error,
      loading: status.loading,
      loaded: status.loaded,
      points: status.points,
      histogram,
      rampRange: status.rampRange,
    });
  }, [status, histogram, setStatus]);

  // Tell the loader where we are looking, so it can pick octree nodes.
  useEffect(() => {
    if (!cesium || !viewer || !settings.enabled || !status.metadata) return;
    const Cesium = cesium;
    const dataBounds = status.metadata.lngLatBounds;
    const refresh = () => {
      // Undefined whenever the horizon is in shot, which includes the opening
      // whole-globe view. Falling back to the survey's own extent means the
      // octree still loads instead of the layer sitting silently at zero nodes.
      const rect = viewer.camera.computeViewRectangle();
      if (!rect) {
        setView(dataBounds, 5000, settings.budget);
        return;
      }
      const deg = (r: number) => Cesium.Math.toDegrees(r);
      const height = viewer.camera.positionCartographic.height;
      const frustum = viewer.camera.frustum;
      // Orthographic mode has no field of view; fall back to its width.
      const fov = "fov" in frustum ? frustum.fov : undefined;
      // Rough but adequate: metres of ground per screen pixel at the centre.
      const mpp = Math.max(
        0.01,
        fov === undefined
          ? Cesium.Math.toDegrees(rect.width) * 111_320 / viewer.canvas.clientWidth
          : (2 * height * Math.tan(fov / 2)) / viewer.canvas.clientHeight,
      );
      setView([deg(rect.west), deg(rect.south), deg(rect.east), deg(rect.north)],
        mpp, settings.budget);
    };
    refresh();
    const remove = viewer.camera.moveEnd.addEventListener(refresh);
    return () => remove();
  }, [cesium, viewer, settings.enabled, settings.budget, status.metadata, setView]);

  // Switching the layer on from the other side of the planet would otherwise
  // load points you cannot see. Frame it once, the first time it is ready.
  const framedRef = useRef(false);
  useEffect(() => {
    if (!settings.enabled) {
      framedRef.current = false;
      return;
    }
    if (framedRef.current || !cesium || !viewer || !status.metadata) return;
    framedRef.current = true;
    const [w, s2, e, n] = status.metadata.lngLatBounds;
    viewer.camera.flyTo({
      destination: cesium.Rectangle.fromDegrees(w, s2, e, n),
      duration: 2,
    });
  }, [cesium, viewer, settings.enabled, status.metadata]);

  // --- terrain ----------------------------------------------------------
  const terrainRef = useRef<TerrainLayerHandle | null>(null);

  useEffect(() => {
    if (!cesium || !viewer || !terrainSettings.enabled) return;
    let cancelled = false;
    let handle: TerrainLayerHandle | null = null;
    const controller = new AbortController();

    loadTerrainLayer(cesium, viewer, TERRAIN_URLS, {
      baseTerrain: baseTerrainRef.current ?? viewer.terrainProvider,
      signal: controller.signal,
    }).then(
      (h) => {
        if (cancelled) return h.destroy();
        handle = h;
        terrainRef.current = h;
        setTerrainStatus({
          meta: h.meta,
          ortho: h.ortho,
          sampleHeight: h.sampleHeight,
          buildingCount: h.buildingCount,
          vegetationCounts: h.vegetationCounts,
          seaLevel: h.seaLevel,
        });
      },
      (err: unknown) => {
        // A cancelled load has already undone itself; that is not an error.
        if (!cancelled && (err as Error)?.name !== "AbortError") {
          setTerrainStatus({ error: String(err) });
        }
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
      terrainRef.current = null;
      handle?.destroy();
    };
  }, [cesium, viewer, terrainSettings.enabled, setTerrainStatus]);

  useEffect(() => {
    terrainRef.current?.setOrtho(terrainSettings.showOrtho, terrainSettings.orthoAlpha);
  }, [terrainSettings.showOrtho, terrainSettings.orthoAlpha]);

  useEffect(() => {
    terrainRef.current?.setBuildings(terrainSettings.showBuildings);
  }, [terrainSettings.showBuildings]);

  useEffect(() => {
    terrainRef.current?.setVegetation(
      terrainSettings.showVegetation,
      terrainSettings.vegetationTiers,
    );
  }, [terrainSettings.showVegetation, terrainSettings.vegetationTiers]);

  // Also keyed on the terrain having loaded, so settings chosen while it was
  // still loading are applied the moment it arrives.
  useEffect(() => {
    terrainRef.current?.setRelief({
      colours: terrainSettings.showRelief,
      colourAlpha: terrainSettings.reliefAlpha,
      contours: terrainSettings.showContours,
      spacing: terrainSettings.contourSpacing,
    });
  }, [terrainStatus.meta, terrainSettings.showRelief, terrainSettings.reliefAlpha,
    terrainSettings.showContours, terrainSettings.contourSpacing]);

  // Frame the survey once the terrain is up, and expose it to the panel. Keyed
  // off the reported metadata, not the handle ref: the load is asynchronous, so
  // an effect that only watched `enabled` would run while the ref was still null
  // and never register anything.
  const terrainFramedRef = useRef(false);
  useEffect(() => {
    if (!terrainSettings.enabled) {
      terrainFramedRef.current = false;
      registerTerrainZoom(null);
      return;
    }
    if (!cesium || !viewer || !terrainStatus.meta) return;
    const [w, s2, e, n] = lonLatBounds(terrainStatus.meta.bounds3857);
    const fly = () =>
      viewer.camera.flyTo({
        destination: cesium.Rectangle.fromDegrees(w, s2, e, n),
        duration: 2,
      });
    registerTerrainZoom(fly);
    if (!terrainFramedRef.current) {
      terrainFramedRef.current = true;
      fly();
    }
    return () => registerTerrainZoom(null);
  }, [cesium, viewer, terrainSettings.enabled, terrainStatus.meta, registerTerrainZoom]);

  // Framing the data, driven from the panel.
  useEffect(() => {
    if (!cesium || !viewer || !status.metadata) {
      registerZoom(null);
      return;
    }
    const [w, s, e, n] = status.metadata.lngLatBounds;
    registerZoom(() => {
      viewer.camera.flyTo({
        destination: cesium.Rectangle.fromDegrees(w, s, e, n),
        duration: 1.5,
      });
    });
    return () => registerZoom(null);
  }, [cesium, viewer, status.metadata, registerZoom]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
