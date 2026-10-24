import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // web/ has its own lockfile; without this Turbopack picks the repo root's.
  turbopack: { root: path.resolve(import.meta.dirname) },
};

export default nextConfig;
