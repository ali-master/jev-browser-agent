import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/cli.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  sourcemap: "external",
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
const declarations = Bun.spawn(["bun", "--bun", "x", "tsc", "--project", "tsconfig.build.json"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await declarations.exited) !== 0) throw new Error("Declaration build failed");
await cp("src/snapshot.js", "dist/snapshot.js");
await cp("src/static", "dist/static", { recursive: true });
console.log("Built library, CLI, declarations and browser assets in dist/");
