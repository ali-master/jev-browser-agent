import { $ } from "bun";

await $`rm -rf dist`;
const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/cli.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  sourcemap: "external",
  check: true,
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
const declarations = Bun.spawn(
  [process.execPath, "--bun", "x", "tsc", "--project", "tsconfig.build.json"],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await declarations.exited) !== 0)
  throw new Error("Declaration build failed");
await Bun.write("dist/snapshot.js", Bun.file("src/snapshot.js"));
for await (const file of new Bun.Glob("**/*").scan({
  cwd: "src/static",
  dot: true,
  onlyFiles: true,
})) {
  await Bun.write(`dist/static/${file}`, Bun.file(`src/static/${file}`));
}
console.log("Built library, CLI, declarations and browser assets in dist/");
