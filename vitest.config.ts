import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Note: Vitest sets its own oxc transform options, so an `esbuild` block
  // here would be silently ignored. Dashboard tests declare
  // `/** @jsxImportSource preact */` per file instead, which also keeps the
  // browser SDK's React entry point compiling against real React.
  resolve: {
    // Tests run against the sources, never against a stale build.
    alias: {
      "@super-logs/shared": src("./packages/shared/src/index.ts"),
      "@super-logs/node": src("./packages/node/src/index.ts"),
      "@super-logs/browser": src("./packages/browser/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.{ts,tsx}"],
  },
});
