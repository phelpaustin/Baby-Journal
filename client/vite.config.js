import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Baby Journal",
        short_name: "Journal",
        description: "Our family's baby journal",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#fbf8f3",
        theme_color: "#2f5d62",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Only the app itself is cached (so it opens offline). API calls and protected files
        // carry tokens and private data: they must never be stored by the service worker.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/_\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: { "/api": { target: process.env.VITE_PB_PROXY || "http://127.0.0.1:8090", changeOrigin: true } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
});
