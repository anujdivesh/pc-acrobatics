import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone, for the Docker image.
  output: "standalone",
  // Served under /pointcloud (nginx maps that path to the container). Keep in
  // step with BASE_PATH in lib/basePath.ts.
  basePath: "/pointcloud",
  // The data route reads files at request time, so Next's file tracing would
  // otherwise copy the whole survey into the server bundle. The data is mounted
  // at runtime instead and must never ship with the app.
  outputFileTracingExcludes: {
    "*": ["public/tonga/**", "backups/**", ".terrain-build/**", ".products-build/**", ".ortho-build/**"],
  },
};

export default nextConfig;
