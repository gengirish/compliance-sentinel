import type { MetadataRoute } from "next";

// Matches the --background token; the app ships a dark theme only.
const BACKGROUND = "#0A0F1C";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Compliance Sentinel",
    short_name: "Sentinel",
    description:
      "Maps regulations to your codebase, obligation by obligation, with the regulation section and file:line cited. By IntelliForge AI.",
    id: "/",
    start_url: "/overview",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Runs",
        url: "/runs",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Rules",
        url: "/rules",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
