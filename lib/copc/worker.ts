/// <reference lib="webworker" />
import { Copc, Key, type Getter, type Hierarchy } from "copc";
import { createLazPerf } from "laz-perf/lib/worker";
import proj4 from "proj4";
import type { Bounds2D, CopcMetadata, NodeData, WorkerRequest, WorkerResponse } from "./types";

type LazPerf = Awaited<ReturnType<typeof createLazPerf>>;

const MAX_CONCURRENT_LOADS = 6;
/** Stop descending once a node's point spacing is finer than this many screen pixels. */
const DETAIL_PIXELS = 1.2;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/** Range-request getter. Kept local so relative URLs work (copc's built-in needs an absolute one). */
function httpGetter(url: string): Getter {
  return async (begin, end) => {
    const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching bytes ${begin}-${end - 1}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

/** Pull a named numeric PARAMETER out of a WKT string. */
function wktParam(wkt: string, name: string): number | undefined {
  const m = wkt.match(new RegExp(`PARAMETER\\s*\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+]+)`, "i"));
  return m ? Number(m[1]) : undefined;
}

/**
 * Build a proj4 definition from the file's own WKT.
 *
 * Read from the projection *parameters*, not the CRS name. Names are not
 * dependable: one survey here is "WGS 84 / UTM zone 58N" and another is
 * "WGS 84 / WGS 84 / UTM 1S", and matching on the word "zone" silently fell
 * through to a pass-through projection — which fed UTM metres in as degrees and
 * threw "Invalid LngLat latitude value". Transverse Mercator parameters cover
 * every UTM zone and anything else built the same way.
 */
function projectionFromWkt(wkt: string | undefined): { def: string; label: string } {
  if (!wkt) return { def: WGS84, label: "no CRS" };

  if (/Transverse_Mercator/i.test(wkt)) {
    const lon0 = wktParam(wkt, "central_meridian") ?? wktParam(wkt, "Longitude of natural origin");
    const lat0 = wktParam(wkt, "latitude_of_origin") ?? 0;
    const k = wktParam(wkt, "scale_factor") ?? 0.9996;
    const x0 = wktParam(wkt, "false_easting") ?? 500000;
    const y0 = wktParam(wkt, "false_northing") ?? 0;

    if (lon0 !== undefined) {
      const def =
        `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=${k} ` +
        `+x_0=${x0} +y_0=${y0} +datum=WGS84 +units=m +no_defs`;

      // A standard UTM zone if the parameters match one; say so, it reads better.
      const zone = (lon0 + 183) / 6;
      const south = y0 === 10000000;
      const isUtm = Number.isInteger(zone) && zone >= 1 && zone <= 60 &&
        k === 0.9996 && x0 === 500000 && (y0 === 0 || south);
      const epsg = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d{4,6})"\s*\]\s*\]?\s*$/);
      const label = isUtm
        ? `${epsg ? `EPSG:${epsg[1]} ` : ""}(UTM ${zone}${south ? "S" : "N"})`
        : epsg
          ? `EPSG:${epsg[1]}`
          : "Transverse Mercator";
      return { def, label };
    }
  }

  if (/GEOGCS/i.test(wkt) && !/PROJCS/i.test(wkt)) {
    return { def: WGS84, label: "geographic (WGS84)" };
  }
  return { def: WGS84, label: "unrecognised CRS — coordinates passed through" };
}

type State = {
  url: string;
  getter: Getter;
  copc: Copc;
  lazPerf: LazPerf;
  toLngLat: proj4.Converter;
  nodes: Hierarchy.Node.Map;
  pages: Hierarchy.Page.Map;
  loadedPages: Set<string>;
  /** Node keys currently handed to the main thread. */
  live: Set<string>;
  inFlight: Set<string>;
  queue: string[];
  /** Bumped on every view change so stale loads can be discarded. */
  generation: number;
};

let state: State | undefined;

async function init(url: string, wasmUrl: string) {
  const getter = httpGetter(url);
  const lazPerf = await createLazPerf({ locateFile: () => wasmUrl });
  const copc = await Copc.create(getter);
  const { nodes, pages } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);

  const { def, label } = projectionFromWkt(copc.wkt);
  const toLngLat = proj4(def, "+proj=longlat +datum=WGS84 +no_defs");

  const { min, max } = copc.header;
  const [west, south] = toLngLat.forward([min[0], min[1]]);
  const [east, north] = toLngLat.forward([max[0], max[1]]);

  state = {
    url,
    getter,
    copc,
    lazPerf,
    toLngLat,
    nodes,
    pages,
    loadedPages: new Set([Key.toString([0, 0, 0, 0])]),
    live: new Set(),
    inFlight: new Set(),
    queue: [],
    generation: 0,
  };

  const metadata: CopcMetadata = {
    pointCount: copc.header.pointCount,
    nativeBounds: [min[0], min[1], min[2], max[0], max[1], max[2]],
    lngLatBounds: [west, south, east, north],
    zRange: [min[2], max[2]],
    spacing: copc.info.spacing,
    pointDataRecordFormat: copc.header.pointDataRecordFormat,
    hasColor: [2, 3, 5, 7, 8, 10].includes(copc.header.pointDataRecordFormat),
    crsLabel: label,
  };
  post({ type: "ready", metadata });
}

/** Axis-aligned bounds of an octree node, in the file's own CRS. */
function nodeBounds(cube: number[], key: string): [number, number, number, number] {
  const [d, x, y] = Key.parse(key);
  const size = (cube[3] - cube[0]) / 2 ** d;
  const minx = cube[0] + x * size;
  const miny = cube[1] + y * size;
  return [minx, miny, minx + size, miny + size];
}

function intersects(a: [number, number, number, number], b: [number, number, number, number]) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Walk the octree breadth-first, taking the coarsest nodes first, and stop at the
 * point budget or once nodes are finer than the screen can show.
 */
function selectNodes(s: State, bounds: Bounds2D, metersPerPixel: number, pointBudget: number) {
  const cube = s.copc.info.cube;
  const [w, sth, e, n] = bounds;
  // Project the view rectangle back into the file's CRS; corners suffice at these scales.
  const c1 = s.toLngLat.inverse([w, sth]);
  const c2 = s.toLngLat.inverse([e, n]);
  const view: [number, number, number, number] = [
    Math.min(c1[0], c2[0]),
    Math.min(c1[1], c2[1]),
    Math.max(c1[0], c2[0]),
    Math.max(c1[1], c2[1]),
  ];

  const selected: string[] = [];
  const pagesToLoad: string[] = [];
  let budget = pointBudget;
  let queue = [Key.toString([0, 0, 0, 0])];

  while (queue.length && budget > 0) {
    const next: string[] = [];
    for (const key of queue) {
      const [depth, x, y, z] = Key.parse(key);
      if (!intersects(nodeBounds(cube, key), view)) continue;

      const node = s.nodes[key];
      if (node) {
        if (node.pointCount > budget) continue;
        selected.push(key);
        budget -= node.pointCount;
      }

      // A key can carry a sub-page instead of (or as well as) node data.
      if (s.pages[key] && !s.loadedPages.has(key)) {
        pagesToLoad.push(key);
        continue;
      }

      const nodeSpacing = s.copc.info.spacing / 2 ** depth;
      if (nodeSpacing < metersPerPixel * DETAIL_PIXELS) continue;

      for (let i = 0; i < 8; i++) {
        next.push(Key.toString([depth + 1, x * 2 + (i & 1), y * 2 + ((i >> 1) & 1), z * 2 + ((i >> 2) & 1)]));
      }
    }
    queue = next;
  }

  return { selected, pagesToLoad };
}

async function loadPages(s: State, keys: string[]) {
  const generation = s.generation;
  await Promise.all(
    keys.map(async (key) => {
      const page = s.pages[key];
      if (!page || s.loadedPages.has(key)) return;
      s.loadedPages.add(key);
      try {
        const sub = await Copc.loadHierarchyPage(s.getter, page);
        Object.assign(s.nodes, sub.nodes);
        Object.assign(s.pages, sub.pages);
      } catch (err) {
        s.loadedPages.delete(key);
        throw err;
      }
    }),
  );
  return generation === s.generation;
}

async function loadNode(s: State, key: string): Promise<void> {
  const node = s.nodes[key];
  if (!node) return;
  const generation = s.generation;

  const view = await Copc.loadPointDataView(s.getter, s.copc, node, { lazPerf: s.lazPerf });
  if (generation !== s.generation || !s.live.has(key)) return;

  const count = view.pointCount;
  const getX = view.getter("X");
  const getY = view.getter("Y");
  const getZ = view.getter("Z");
  const getC = view.getter("Classification");
  const getI = view.getter("Intensity");
  const hasColor = "Red" in view.dimensions;
  const getR = hasColor ? view.getter("Red") : undefined;
  const getG = hasColor ? view.getter("Green") : undefined;
  const getB = hasColor ? view.getter("Blue") : undefined;

  const positions = new Float64Array(count * 3);
  const elevations = new Float32Array(count);
  const classifications = new Uint8Array(count);
  const intensities = new Uint16Array(count);
  const colors = hasColor ? new Uint8Array(count * 3) : new Uint8Array(0);

  // 16-bit colour is the LAS norm, but plenty of files store 8-bit values in those
  // fields. Scale from whichever range this node actually uses.
  let colorMax = 0;
  if (getR && getG && getB) {
    for (let i = 0; i < count; i++) {
      colorMax = Math.max(colorMax, getR(i), getG(i), getB(i));
    }
  }
  const colorShift = colorMax > 255 ? 8 : 0;

  for (let i = 0; i < count; i++) {
    const z = getZ(i);
    const [lng, lat] = s.toLngLat.forward([getX(i), getY(i)]);
    positions[i * 3] = lng;
    positions[i * 3 + 1] = lat;
    positions[i * 3 + 2] = z;
    elevations[i] = z;
    classifications[i] = getC(i);
    intensities[i] = getI(i);
    if (getR && getG && getB) {
      colors[i * 3] = getR(i) >> colorShift;
      colors[i * 3 + 1] = getG(i) >> colorShift;
      colors[i * 3 + 2] = getB(i) >> colorShift;
    }
  }

  if (generation !== s.generation || !s.live.has(key)) return;

  const data: NodeData = {
    key,
    depth: Key.parse(key)[0],
    pointCount: count,
    positions,
    colors,
    classifications,
    intensities,
    elevations,
  };
  post({ type: "node", node: data }, [
    positions.buffer,
    colors.buffer,
    classifications.buffer,
    intensities.buffer,
    elevations.buffer,
  ]);
}

function reportProgress(s: State) {
  let points = 0;
  for (const key of s.live) points += s.nodes[key]?.pointCount ?? 0;
  post({ type: "progress", loading: s.queue.length + s.inFlight.size, loaded: s.live.size, points });
}

function pump(s: State) {
  while (s.inFlight.size < MAX_CONCURRENT_LOADS && s.queue.length) {
    const key = s.queue.shift();
    if (!key) break;
    s.inFlight.add(key);
    loadNode(s, key)
      .catch((err) => post({ type: "error", message: `node ${key}: ${String(err)}` }))
      .finally(() => {
        s.inFlight.delete(key);
        reportProgress(s);
        pump(s);
      });
  }
}

async function setView(bounds: Bounds2D, metersPerPixel: number, pointBudget: number) {
  const s = state;
  if (!s) return;
  s.generation++;

  const { selected, pagesToLoad } = selectNodes(s, bounds, metersPerPixel, pointBudget);
  const wanted = new Set(selected);

  const dropped = [...s.live].filter((key) => !wanted.has(key));
  if (dropped.length) {
    dropped.forEach((key) => s.live.delete(key));
    post({ type: "drop", keys: dropped });
  }

  s.queue = selected.filter((key) => !s.live.has(key) && !s.inFlight.has(key));
  s.queue.forEach((key) => s.live.add(key));
  reportProgress(s);
  pump(s);

  if (pagesToLoad.length) {
    // Newly loaded hierarchy pages reveal deeper nodes, so re-run the selection.
    const stillCurrent = await loadPages(s, pagesToLoad).catch((err) => {
      post({ type: "error", message: `hierarchy: ${String(err)}` });
      return false;
    });
    if (stillCurrent) await setView(bounds, metersPerPixel, pointBudget);
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "init") await init(msg.url, msg.wasmUrl);
    else if (msg.type === "setView") await setView(msg.bounds, msg.metersPerPixel, msg.pointBudget);
    else if (msg.type === "dispose") state = undefined;
  } catch (err) {
    post({ type: "error", message: String(err instanceof Error ? err.message : err) });
  }
};
