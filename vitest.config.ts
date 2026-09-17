import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources, never against a stale build.
    alias: {
      "@super-logs/shared": src("./packages/shared/src/index.ts"),
      "@super-logs/node": src("./packages/node/src/index.ts"),
      "@super-logs/browser": src("./packages/browser/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
