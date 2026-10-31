import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // web/ has its own lockfile; without this Turbopack picks the repo root's.
  turbopack: { root: path.resolve(import.meta.dirname) },
  async headers() {
    return [
      {
        // The browser must always re-check the worker script, or updates stall.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
