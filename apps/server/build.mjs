/**
 * Bundles the server into one file.
 *
 * The alternative is shipping `node_modules` into the image and resolving a few
 * hundred files at every boot. Bundling means the runtime stage is a Node base
 * image, one `.js` and the dashboard's assets — nothing to install, nothing to
 * resolve, and no lockfile games to install only the server's production
 * dependencies.
 *
 * Types are checked by `npm run typecheck`; esbuild only transpiles, so the
 * build script runs the check first rather than trusting the bundle.
 */
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: false, // A readable stack trace is worth more than the kilobytes.
  // Node builtins are external automatically; nothing else should be.
  packages: "bundle",
  banner: {
    js: "// Super-Logs server — bundled. Sources: https://github.com/The-Onion-Team/Super-Logs",
  },
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
console.log(`bundled ${(bytes / 1024).toFixed(0)} KB`);
