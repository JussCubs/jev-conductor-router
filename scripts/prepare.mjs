import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function tscPath() {
  try { return require.resolve("typescript/bin/tsc"); }
  catch { return null; }
}

// Git installs run this before the package is packed. npm installs devDependencies
// first, so typescript is usually already present. If a host omitted them, fetch
// the compiler without saving it into package.json.
let tsc = tscPath();
if (!tsc) {
  const result = spawnSync("npm", [
    "install", "--no-save", "--ignore-scripts", "--no-package-lock",
    "typescript@~5.7.3", "@types/node@^22.0.0",
  ], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  tsc = tscPath();
}
if (!tsc) {
  console.error("typescript is required to build jev-conductor-router from source.");
  process.exit(1);
}

const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { stdio: "inherit" });
process.exit(build.status ?? 1);
