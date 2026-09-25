// Cesium is loaded as a prebuilt script rather than bundled (Turbopack corrupts
// binary data inlined in its modules), and it fetches its workers, widget CSS and
// assets at runtime from CESIUM_BASE_URL. Copy it all into public/ for Next to serve.
import { cpSync, rmSync } from "node:fs";

const src = "node_modules/cesium/Build/Cesium";
const dest = "public/cesium";

rmSync(dest, { recursive: true, force: true });
for (const dir of ["Assets", "ThirdParty", "Widgets", "Workers"]) {
  cpSync(`${src}/${dir}`, `${dest}/${dir}`, { recursive: true });
}
cpSync(`${src}/Cesium.js`, `${dest}/Cesium.js`);
