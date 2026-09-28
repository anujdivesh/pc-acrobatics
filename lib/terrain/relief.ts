import type * as CesiumType from "cesium";

type Cesium = typeof CesiumType;

/**
 * Depth / elevation colours, in metres relative to the water level: blues below
 * it, sand to brown above, both lightest at the waterline. Lightness runs one way
 * on each side so depth reads as depth without the legend.
 */
export const RELIEF_STOPS: [number, string][] = [
  [-45, "#08306b"],
  [-20, "#2171b5"],
  [-10, "#4292c6"],
  [-5, "#6baed6"],
  [-2, "#9ecae1"],
  [-0.01, "#deebf7"],
  [0, "#f3efe0"],
  [2, "#e6d5a8"],
  [5, "#cdb07a"],
  [15, "#a37c4a"],
  [45, "#5c3d1e"],
];
const RAMP_MIN = RELIEF_STOPS[0][0];
const RAMP_MAX = RELIEF_STOPS[RELIEF_STOPS.length - 1][0];

export type ReliefSettings = {
  colours: boolean;
  colourAlpha: number;
  contours: boolean;
  /** Metres between contour lines; every fifth is drawn heavier. */
  spacing: number;
};

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** The stops as a 1024-px strip spanning RAMP_MIN..RAMP_MAX, sampled linearly by value. */
function rampCanvas(): HTMLCanvasElement {
  const width = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, 1);
  for (let px = 0; px < width; px++) {
    const v = RAMP_MIN + ((px + 0.5) / width) * (RAMP_MAX - RAMP_MIN);
    let i = 0;
    while (i < RELIEF_STOPS.length - 2 && v > RELIEF_STOPS[i + 1][0]) i++;
    const [v0, c0] = RELIEF_STOPS[i];
    const [v1, c1] = RELIEF_STOPS[i + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    const a = hex(c0), b = hex(c1);
    for (let k = 0; k < 3; k++) img.data[px * 4 + k] = Math.round(a[k] + (b[k] - a[k]) * t);
    img.data[px * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Heights come from the terrain mesh itself, so colours and lines sit exactly on
// the surface at any zoom. Everything is relative to `seaLevel`, and nothing is
// drawn outside the survey rectangle, where the terrain is only fill.
const SOURCE = /* glsl */ `
uniform sampler2D ramp;
uniform float seaLevel;
uniform float rampMin;
uniform float rampMax;
uniform float colourAlpha;
uniform float showColours;
uniform float showContours;
uniform float spacing;
uniform vec4 lineColor;
uniform vec4 bounds;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.alpha = 0.0;

    // Geodetic lon/lat of this fragment, to keep to the survey footprint.
    vec3 p = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
    float lon = atan(p.y, p.x);
    float lat = atan(p.z, length(p.xy) * (1.0 - 0.00669437999014));
    if (lon < bounds.x || lat < bounds.y || lon > bounds.z || lat > bounds.w) {
        return material;
    }

    float rel = materialInput.height - seaLevel;
    vec3 colour = vec3(0.0);
    float alpha = 0.0;
    if (showColours > 0.5) {
        float t = clamp((rel - rampMin) / (rampMax - rampMin), 0.0, 1.0);
        colour = texture(ramp, vec2(t, 0.5)).rgb;
        alpha = colourAlpha;
    }

    if (showContours > 0.5) {
        // Metres of height per pixel here, so lines keep a constant screen width.
        float perPixel = max(abs(dFdx(rel)), abs(dFdy(rel)));
        float minor = abs(rel - spacing * floor(rel / spacing + 0.5));
        float majorStep = spacing * 5.0;
        float major = abs(rel - majorStep * floor(rel / majorStep + 0.5));
        float halfWidth = perPixel * czm_pixelRatio;
        if (major < halfWidth * 1.1) {
            colour = lineColor.rgb;
            alpha = 1.0;
        } else if (minor < halfWidth * 0.55) {
            colour = mix(colour, lineColor.rgb, alpha > 0.0 ? 0.7 : 1.0);
            alpha = max(alpha, 0.75);
        }
    }

    material.diffuse = colour;
    material.alpha = alpha;
    return material;
}
`;

export type ReliefHandle = {
  update: (s: ReliefSettings) => void;
  destroy: () => void;
};

/**
 * Colour and contour the globe by height relative to the water level, inside
 * `rectangle` only. Installed as the globe material; removed when both are off.
 */
export function createRelief(
  Cesium: Cesium,
  viewer: CesiumType.Viewer,
  seaLevel: number,
  rectangle: CesiumType.Rectangle,
): ReliefHandle {
  const globe = viewer.scene.globe;
  const previous = globe.material;
  const material = new Cesium.Material({
    // No fabric `type`: Cesium caches named materials, so a second terrain load
    // in the same session would throw on a fixed name. Unnamed, each gets its own.
    fabric: {
      uniforms: {
        ramp: rampCanvas(),
        seaLevel,
        rampMin: RAMP_MIN,
        rampMax: RAMP_MAX,
        colourAlpha: 0.85,
        showColours: 0,
        showContours: 0,
        spacing: 2,
        lineColor: Cesium.Color.fromCssColorString("#1f2937"),
        bounds: new Cesium.Cartesian4(rectangle.west, rectangle.south, rectangle.east, rectangle.north),
      },
      source: SOURCE,
    },
    translucent: true,
  });

  return {
    update({ colours, colourAlpha, contours, spacing }) {
      if (viewer.isDestroyed()) return;
      const u = material.uniforms;
      u.showColours = colours ? 1 : 0;
      u.showContours = contours ? 1 : 0;
      u.colourAlpha = colourAlpha;
      u.spacing = spacing;
      // Only on the globe while it draws something: a material costs every tile.
      globe.material = colours || contours ? material : previous;
    },
    destroy() {
      if (viewer.isDestroyed()) return;
      // Detached, not destroyed: the globe can still draw with it for the rest
      // of this frame, and destroying it under the renderer stops rendering.
      if (globe.material === material) globe.material = previous;
    },
  };
}
