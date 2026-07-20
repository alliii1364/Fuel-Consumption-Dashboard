// Copies the Next static export (fuel-dashboard/out) into ./www and makes the
// app boot straight into the driver experience by replacing the root
// index.html with a redirect to driver.html. Run after `npm run build:web`.
import { cp, rm, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../fuel-dashboard/out");
const www = resolve(here, "../www");

try {
  await access(`${out}/driver.html`);
} catch {
  console.error(`\n✗ Export not found at ${out}/driver.html. Run "npm run build:web" first.\n`);
  process.exit(1);
}

await rm(www, { recursive: true, force: true });
await cp(out, www, { recursive: true });

// Boot the shell directly into the driver app (root index is the manager
// dashboard, which the driver build does not use).
const redirect = `<!doctype html><meta charset="utf-8">
<title>FuelIQ Driver</title>
<script>location.replace("/driver.html" + location.search + location.hash);</script>`;
await writeFile(`${www}/index.html`, redirect, "utf8");

console.log(`✓ www prepared from export → ${www} (boots to /driver.html)`);
