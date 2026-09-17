import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  // Keep `node:` specifiers: bundlers (Next, Vite) resolve them as built-ins unambiguously.
  removeNodeProtocol: false,
  target: "node18",
  // Shipped self-contained: the shared event model is bundled in, so the SDK
  // has zero runtime dependencies.
  noExternal: ["@super-logs/shared"],
  dts: { resolve: [/^@super-logs\//] },
  clean: true,
  sourcemap: true,
});
