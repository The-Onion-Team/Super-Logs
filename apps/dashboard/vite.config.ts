import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    // No inline scripts: the server's CSP only allows same-origin script files.
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        // The API checks Origin against SUPER_LOGS_PUBLIC_URL; in dev that is the API's own origin.
        headers: { origin: "http://localhost:3000" },
      },
    },
  },
});
