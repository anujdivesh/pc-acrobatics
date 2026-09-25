"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type * as CesiumType from "cesium";

type Cesium = typeof CesiumType;

export type MapHandle = { cesium: Cesium; viewer: CesiumType.Viewer } | null;

type Ctx = {
  map: MapHandle;
  setMap: (map: MapHandle) => void;
};

const MapCtx = createContext<Ctx | null>(null);

/** Shares the live Cesium viewer with UI outside the globe, such as the tools. */
export function MapProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<MapHandle>(null);
  const value = useMemo(() => ({ map, setMap }), [map]);
  return <MapCtx.Provider value={value}>{children}</MapCtx.Provider>;
}

export function useMap() {
  const ctx = useContext(MapCtx);
  if (!ctx) throw new Error("useMap must be used inside MapProvider");
  return ctx;
}
