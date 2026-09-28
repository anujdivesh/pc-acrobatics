/** Shape of public/tonga/products/manifest.json, written by scripts/build_products.py. */

export type Overlay = { id: string; label: string; url: string; rect: [number, number, number, number] };

export type VectorStyle = { stroke?: string; width?: number; fill?: string; point?: string; size?: number };

export type Vector = { id: string; label: string; url: string; style: VectorStyle; count: number };

export type Legend =
  | { type: "ramp"; stops: [number, string][]; label?: string }
  | { type: "classes"; items: [string, string][] };

export type ProductData = {
  overlays?: Overlay[];
  vectors?: Vector[];
  legend?: Legend;
  legends?: Record<string, Legend>;
  // Per-product statistics; each panel knows its own shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stats: any;
};

export type Manifest = {
  survey: string;
  waterLevel: number;
  heights: string;
  resolution_m: number;
  bounds: [number, number, number, number];
  products: Record<string, ProductData>;
};

/** What the map should show right now. */
export type MapLayers = {
  overlays: Overlay[];
  vectors: Vector[];
};
