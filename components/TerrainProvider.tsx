"use client";

import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from "react";
import type { VegetationClass } from "@/lib/terrain/vegetation";
import type { OrthoMeta, TerrainMeta } from "@/lib/terrain/types";

export type TerrainSettings = {
  enabled: boolean;
  showOrtho: boolean;
  orthoAlpha: number;
  showBuildings: boolean;
  showVegetation: boolean;
  vegetationTiers: Record<VegetationClass, boolean>;
  /** Depth / elevation colours on the terrain, relative to the water level. */
  showRelief: boolean;
  reliefAlpha: number;
  showContours: boolean;
  /** Metres between contour lines. */
  contourSpacing: number;
};

export type TerrainStatus = {
  meta?: TerrainMeta;
  ortho?: OrthoMeta;
  error?: string;
  /** Terrain height sampled at the survey centre, proving the mesh is live. */
  sampleHeight?: number;
  buildingCount?: number;
  vegetationCounts?: Record<number, number>;
  /** Height the relief counts from (the measured water level). */
  seaLevel?: number;
};

const DEFAULTS: TerrainSettings = {
  enabled: false,
  showOrtho: true,
  orthoAlpha: 1,
  showBuildings: true,
  showVegetation: true,
  vegetationTiers: { 3: true, 4: true, 5: true },
  showRelief: false,
  reliefAlpha: 0.85,
  showContours: false,
  contourSpacing: 2,
};

type Ctx = {
  settings: TerrainSettings;
  update: (patch: Partial<TerrainSettings>) => void;
  status: TerrainStatus;
  setStatus: (s: TerrainStatus | ((p: TerrainStatus) => TerrainStatus)) => void;
  registerZoom: (fn: (() => void) | null) => void;
  zoomToData: () => void;
};

const TerrainCtx = createContext<Ctx | null>(null);

/** Shared state between the second accordion and the globe. */
export function TerrainLayerProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<TerrainSettings>(DEFAULTS);
  const [status, setStatus] = useState<TerrainStatus>({});
  const zoomRef = useRef<(() => void) | null>(null);

  const update = useCallback(
    (patch: Partial<TerrainSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const registerZoom = useCallback((fn: (() => void) | null) => {
    zoomRef.current = fn;
  }, []);
  const zoomToData = useCallback(() => zoomRef.current?.(), []);

  const value = useMemo(
    () => ({ settings, update, status, setStatus, registerZoom, zoomToData }),
    [settings, update, status, registerZoom, zoomToData]);
  return <TerrainCtx.Provider value={value}>{children}</TerrainCtx.Provider>;
}

export function useTerrainLayer() {
  const ctx = useContext(TerrainCtx);
  if (!ctx) throw new Error("useTerrainLayer must be used inside TerrainLayerProvider");
  return ctx;
}
