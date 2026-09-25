import type { ColorMode } from "./types";

/**
 * ASPRS class names. Only the codes whose meaning is fixed across LAS versions are
 * named; anything else is shown by number so a producer-specific code is never
 * mislabelled.
 */
const ASPRS_NAMES: Record<number, string> = {
  0: "Never classified",
  1: "Unassigned",
  2: "Ground",
  3: "Low vegetation",
  4: "Medium vegetation",
  5: "High vegetation",
  6: "Building",
  7: "Low point (noise)",
  8: "Model key-point",
  9: "Water",
  10: "Rail",
  11: "Road surface",
  12: "Overlap",
  17: "Bridge deck",
  18: "High noise",
  // ASPRS LAS 1.4 bathymetric domain profile.
  40: "Bathymetric bottom",
  41: "Water surface",
  42: "Derived water surface",
  43: "Submerged object",
  44: "IHO S-57 object",
  45: "No bottom found",
};

export const classLabel = (code: number) => ASPRS_NAMES[code] ?? `Class ${code}`;

/** Codes hidden on first load: they are noise by definition and dominate this data. */
export const NOISE_CLASSES = [7, 18];

const CLASS_COLORS: Record<number, [number, number, number]> = {
  0: [150, 150, 150],
  1: [190, 190, 190],
  2: [166, 116, 72],
  3: [160, 200, 110],
  4: [90, 170, 80],
  5: [40, 120, 55],
  6: [220, 110, 90],
  7: [230, 70, 70],
  8: [200, 170, 90],
  9: [70, 140, 220],
  10: [160, 110, 200],
  11: [130, 130, 140],
  12: [200, 160, 200],
  13: [235, 190, 80],
  14: [120, 200, 200],
  15: [180, 140, 90],
  16: [200, 200, 120],
  17: [190, 130, 170],
  18: [250, 120, 120],
  40: [40, 140, 190],
  41: [120, 200, 220],
  42: [150, 210, 225],
  43: [200, 160, 120],
  44: [190, 150, 200],
  45: [110, 110, 130],
};

const FALLBACK_CLASS_COLOR: [number, number, number] = [170, 170, 170];

export const classColor = (code: number) => CLASS_COLORS[code] ?? FALLBACK_CLASS_COLOR;

/** Viridis control points; perceptually uniform and readable on light and dark basemaps. */
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

export function rampColor(t: number, out: Uint8Array, at: number) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[i + 1];
  out[at] = a[0] + (b[0] - a[0]) * f;
  out[at + 1] = a[1] + (b[1] - a[1]) * f;
  out[at + 2] = a[2] + (b[2] - a[2]) * f;
}

export const rampCss = () =>
  `linear-gradient(to right, ${VIRIDIS.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(", ")})`;

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  elevation: "Elevation",
  classification: "Classification",
  intensity: "Intensity",
  rgb: "RGB",
};
