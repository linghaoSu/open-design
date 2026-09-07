import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  packages: "external",
  platform: "node",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
};

await build({
  ...shared,
  entryPoints: ["./src/index.ts"],
  outfile: "./dist/index.mjs",
});

await build({
  ...shared,
  entryPoints: ["./src/cli/main.ts"],
  outfile: "./dist/od-vela.mjs",
});
