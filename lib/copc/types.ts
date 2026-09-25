/** [west, south, east, north] in WGS84 degrees. */
export type Bounds2D = [number, number, number, number];

export type ColorMode = "rgb" | "elevation" | "classification" | "intensity";

/** Everything the UI needs once the COPC header + root hierarchy page are read. */
export type CopcMetadata = {
  pointCount: number;
  /** Data extent in the file's own (projected) CRS. */
  nativeBounds: [number, number, number, number, number, number];
  /** Data extent as [west, south, east, north] in WGS84 degrees. */
  lngLatBounds: Bounds2D;
  zRange: [number, number];
  spacing: number;
  pointDataRecordFormat: number;
  hasColor: boolean;
  /** EPSG-ish label derived from the file's WKT, for display. */
  crsLabel: string;
};

/** A decoded octree node, ready to hand to deck.gl. */
export type NodeData = {
  key: string;
  depth: number;
  pointCount: number;
  /** [lng, lat, z] triples. Float64 keeps deck.gl's fp64 path accurate. */
  positions: Float64Array;
  /** RGB triples, 0-255. Empty when the file carries no colour. */
  colors: Uint8Array;
  classifications: Uint8Array;
  intensities: Uint16Array;
  /** Z in metres, kept separate so colour modes can recompute without a reload. */
  elevations: Float32Array;
};

export type WorkerRequest =
  | { type: "init"; url: string; wasmUrl: string }
  | { type: "setView"; bounds: Bounds2D; metersPerPixel: number; pointBudget: number }
  | { type: "dispose" };

export type WorkerResponse =
  | { type: "ready"; metadata: CopcMetadata }
  | { type: "node"; node: NodeData }
  | { type: "drop"; keys: string[] }
  | { type: "progress"; loading: number; loaded: number; points: number }
  | { type: "error"; message: string };
