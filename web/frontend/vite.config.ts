import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by Flask from /static/app/. Everything is bundled at build
// time and shipped in the image — nothing is fetched from a CDN at runtime
// (NFR-03, air-gapped). The build output lands in the Flask static dir.
export default defineConfig({
  plugins: [react()],
  base: "/static/app/",
  build: {
    outDir: "../pebbles_web/static/app",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // Dev-only: proxy the JSON API to a locally-running Flask.
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
});
