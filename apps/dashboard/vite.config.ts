import { defineConfig } from "vite";

export default defineConfig({
  // Preact, imported directly rather than aliased from "react": the dashboard
  // needs only hooks, StrictMode and createRoot, and this keeps ~61 KB gzip of
  // React out of the bundle. No @preact/preset-vite either — it pulls in Babel
  // (~15 MB of dev dependencies) purely for Fast Refresh.
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
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
