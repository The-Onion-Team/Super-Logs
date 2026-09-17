import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react.tsx"],
  format: ["esm", "cjs"],
  platform: "browser",
  target: "es2020",
  noExternal: ["@super-logs/shared"],
  external: ["react"],
  dts: { resolve: [/^@super-logs\//] },
  // Browser-only code: mark it for React Server Components hosts (Next.js).
  banner: { js: '"use client";' },
  clean: true,
  minify: true,
  sourcemap: true,
});
