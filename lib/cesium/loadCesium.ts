import type * as CesiumType from "cesium";

import { withBase } from "@/lib/basePath";

export type Cesium = typeof CesiumType;

declare global {
  interface Window {
    CESIUM_BASE_URL: string;
    Cesium?: Cesium;
  }
}

const CESIUM_BASE_URL = withBase("/cesium");

let cesiumPromise: Promise<Cesium> | undefined;

// Load the prebuilt Cesium bundle from public/ once. Bundling the npm package
// through Turbopack breaks binary data inlined in Cesium's modules.
export function loadCesium(): Promise<Cesium> {
  cesiumPromise ??= new Promise((resolve, reject) => {
    if (window.Cesium) return resolve(window.Cesium);
    window.CESIUM_BASE_URL = CESIUM_BASE_URL;

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `${CESIUM_BASE_URL}/Cesium.js`;
    script.onload = () => resolve(window.Cesium!);
    script.onerror = () => {
      cesiumPromise = undefined;
      reject(new Error(`Failed to load ${script.src}`));
    };
    document.head.appendChild(script);
  });
  return cesiumPromise;
}
