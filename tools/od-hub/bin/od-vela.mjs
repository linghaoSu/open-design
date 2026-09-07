#!/usr/bin/env node

// `od-vela` is spawned by the daemon as `VELA_BIN`. It must stay fast and must
// never write unexpected stderr (the daemon regex-classifies stderr), so it
// skips the build-freshness assertion and executes the bundled shim directly.
// Rebuild with `pnpm --filter @open-design/tools-od-hub build`.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entryDir = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(entryDir, "..", "dist/od-vela.mjs");

await import(pathToFileURL(distEntry).href);
