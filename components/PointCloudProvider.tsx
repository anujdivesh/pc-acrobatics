"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ColorMode, CopcMetadata, NodeData } from "@/lib/copc/types";
import { NOISE_CLASSES } from "@/lib/copc/palette";

export type PointCloudSettings = {
  enabled: boolean;
  pointSize: number;
  colorMode: ColorMode;
  /** Points held on the GPU at once. */
  budget: number;
  /** ASPRS codes to leave out; noise dominates this survey. */
  hidden: number[];
};

export type PointCloudStatus = {
  metadata?: CopcMetadata;
  error?: string;
  /** Octree nodes in flight, resident, and the point total across them. */
  loading: number;
  loaded: number;
  points: number;
  /** Classes actually seen so far, with counts, for the filter list. */
  histogram: Record<number, number>;
  /** Elevation range the colour ramp is stretched over, which is not the
   *  file's full range -- see the viewer. */
  rampRange?: [number, number];
};

const DEFAULTS: PointCloudSettings = {
  enabled: false,
  pointSize: 2,
  colorMode: "elevation",
  budget: 400_000,
  hidden: NOISE_CLASSES,
};

type Ctx = {
  settings: PointCloudSettings;
  update: (patch: Partial<PointCloudSettings>) => void;
  status: PointCloudStatus;
  setStatus: (s: PointCloudStatus | ((p: PointCloudStatus) => PointCloudStatus)) => void;
  /** The viewer registers this so the panel can frame the data. */
  registerZoom: (fn: (() => void) | null) => void;
  zoomToData: () => void;
  /** The viewer registers this so tools can read the points it has loaded. */
  registerNodes: (fn: (() => Iterable<NodeData>) | null) => void;
  getNodes: () => Iterable<NodeData>;
};

const PointCloudCtx = createContext<Ctx | null>(null);

/**
 * The side panel and the globe are siblings, so the controls and the thing they
 * control cannot pass props to each other. This holds the little state they
 * share: the viewer owns the loader and reports progress, the panel reads it.
 */
export function PointCloudProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PointCloudSettings>(DEFAULTS);
  const [status, setStatus] = useState<PointCloudStatus>({
    loading: 0,
    loaded: 0,
    points: 0,
    histogram: {},
  });
  const zoomRef = useRef<(() => void) | null>(null);

  const update = useCallback(
    (patch: Partial<PointCloudSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  const registerZoom = useCallback((fn: (() => void) | null) => {
    zoomRef.current = fn;
  }, []);
  const zoomToData = useCallback(() => zoomRef.current?.(), []);
  const nodesRef = useRef<(() => Iterable<NodeData>) | null>(null);
  const registerNodes = useCallback((fn: (() => Iterable<NodeData>) | null) => {
    nodesRef.current = fn;
  }, []);
  const getNodes = useCallback(() => nodesRef.current?.() ?? [], []);

  const value = useMemo(
    () => ({
      settings, update, status, setStatus, registerZoom, zoomToData, registerNodes, getNodes,
    }),
    [settings, update, status, registerZoom, zoomToData, registerNodes, getNodes],
  );
  return <PointCloudCtx.Provider value={value}>{children}</PointCloudCtx.Provider>;
}

export function usePointCloud() {
  const ctx = useContext(PointCloudCtx);
  if (!ctx) throw new Error("usePointCloud must be used inside PointCloudProvider");
  return ctx;
}
