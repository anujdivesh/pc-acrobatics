"use client";

import dynamic from "next/dynamic";

// Cesium touches window/WebGL at import time, so it can only render on the client.
const CesiumViewer = dynamic(() => import("./CesiumViewer"), { ssr: false });

export default function CesiumMap() {
  return <CesiumViewer />;
}
