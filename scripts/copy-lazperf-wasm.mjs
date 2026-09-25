// laz-perf ships its wasm next to its JS; bundlers rewrite that path, so we serve
// the wasm ourselves from /public and point Emscripten's locateFile at it.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve("laz-perf/lib/worker/index.js")), "laz-perf.wasm");
const dest = join(process.cwd(), "public", "laz-perf.wasm");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied ${src} -> ${dest}`);
