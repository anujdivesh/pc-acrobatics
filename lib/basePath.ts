/**
 * The app is served under this prefix (nginx maps /pointcloud to the container).
 * Next applies it to pages and <Link>s by itself; anything built by hand -- data
 * fetches, the Cesium runtime, the laz-perf wasm, form targets, redirects,
 * cookie paths -- goes through withBase(). Keep in step with next.config.ts.
 */
export const BASE_PATH = "/pointcloud";

export const withBase = (path: string) => `${BASE_PATH}${path}`;
