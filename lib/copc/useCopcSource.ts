"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import type { Bounds2D, CopcMetadata, NodeData, WorkerRequest, WorkerResponse } from "./types";

export type CopcStatus = {
  metadata?: CopcMetadata;
  /** Robust elevation range for the colour ramp; see the "node" case below. */
  rampRange?: [number, number];
  error?: string;
  loading: number;
  loaded: number;
  points: number;
};

const EMPTY_NODES: ReadonlyMap<string, NodeData> = new Map();
/** Frozen so the "off" return value keeps a stable identity across renders. */
const IDLE_STATUS: CopcStatus = { loading: 0, loaded: 0, points: 0 };

/**
 * Owns the loader worker and the set of octree nodes currently resident.
 * Arrivals are buffered and flushed once per frame, so a burst of small nodes
 * produces one re-render rather than dozens.
 */
export function useCopcSource(url: string) {
  const workerRef = useRef<Worker | null>(null);
  const [nodes, setNodes] = useState<ReadonlyMap<string, NodeData>>(EMPTY_NODES);
  const [status, setStatus] = useState<CopcStatus>({ loading: 0, loaded: 0, points: 0 });

  useEffect(() => {
    // No url means the layer is switched off: do not spin up a worker. What is
    // already in state is not cleared here -- resetting it would be a setState
    // inside an effect; the hook reports the idle values instead, and a re-enable
    // starts a fresh worker whose "ready" clears them.
    if (!url) return;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    // The header's min/max makes a poor colour range: this survey spans -121 m
    // of noise to a 185 m spike, which flattens every real point into one shade.
    // Take the 2nd-98th percentile of the first node instead -- being the top of
    // the octree it samples the whole extent -- and then leave it alone, so the
    // colours do not shift as nodes come and go.
    let rampRange: [number, number] | null = null;

    const pendingAdds = new Map<string, NodeData>();
    const pendingDrops = new Set<string>();
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      if (!pendingAdds.size && !pendingDrops.size) return;
      const adds = [...pendingAdds.values()];
      const drops = [...pendingDrops];
      pendingAdds.clear();
      pendingDrops.clear();
      setNodes((prev) => {
        const next = new Map(prev);
        drops.forEach((key) => next.delete(key));
        adds.forEach((node) => next.set(node.key, node));
        return next;
      });
    };

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case "ready":
          // A fresh file: anything held from a previous one no longer applies.
          rampRange = null;
          setNodes(EMPTY_NODES);
          setStatus({ loading: 0, loaded: 0, points: 0, metadata: msg.metadata });
          break;
        case "node": {
          pendingDrops.delete(msg.node.key);
          pendingAdds.set(msg.node.key, msg.node);
          if (!rampRange && msg.node.pointCount > 0) {
            const z = Float32Array.from(
              msg.node.elevations.slice(0, msg.node.pointCount),
            ).sort();
            const at = (q: number) => z[Math.floor(q * (z.length - 1))];
            rampRange = [at(0.02), at(0.98)];
            const range = rampRange;
            setStatus((s) => ({ ...s, rampRange: range }));
          }
          schedule();
          break;
        }
        case "drop":
          msg.keys.forEach((key) => {
            pendingAdds.delete(key);
            pendingDrops.add(key);
          });
          schedule();
          break;
        case "progress":
          setStatus((s) => ({ ...s, loading: msg.loading, loaded: msg.loaded, points: msg.points }));
          break;
        case "error":
          setStatus((s) => ({ ...s, error: msg.message }));
          break;
      }
    };
    worker.onerror = (event) =>
      setStatus((s) => ({ ...s, error: event.message || "point-cloud worker failed" }));

    worker.postMessage({ type: "init", url, wasmUrl: withBase("/laz-perf.wasm") } satisfies WorkerRequest);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      worker.postMessage({ type: "dispose" } satisfies WorkerRequest);
      worker.terminate();
      workerRef.current = null;
    };
  }, [url]);

  const setView = useCallback((bounds: Bounds2D, metersPerPixel: number, pointBudget: number) => {
    workerRef.current?.postMessage({
      type: "setView",
      bounds,
      metersPerPixel,
      pointBudget,
    } satisfies WorkerRequest);
  }, []);

  const active = Boolean(url);
  return {
    nodes: active ? nodes : EMPTY_NODES,
    status: active ? status : IDLE_STATUS,
    setView,
  };
}
