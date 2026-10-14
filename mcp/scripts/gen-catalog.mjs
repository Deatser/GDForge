// Generates src/data/objects.json from a dump of the running game.
//
// The mod's "catalog.dump" bridge method walks every object ID the game knows
// and reports its sprite frame, the build tab its button is in, and what a
// freshly set up instance says about itself (gameplay type, C++ class, size,
// default layering). Regenerate after a game update:
//
//   1. open any level in the editor (the build tabs only exist there)
//   2. curl -s -X POST http://127.0.0.1:47821/rpc -H 'X-GDBuilder: 1' \
//        -d '{"method":"catalog.dump"}' > dump.json
//   3. node scripts/gen-catalog.mjs dump.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error("usage: node scripts/gen-catalog.mjs <catalog dump json>");
  process.exit(1);
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
if (!dump.ok) {
  console.error("dump is not a successful bridge reply:", dump.error);
  process.exit(1);
}

// "16EffectGameObject" (Itanium) or "class EffectGameObject" (MSVC)
const className = (mangled) => mangled.replace(/^(class |struct )/, "").replace(/^\d+/, "");
const frameName = (frame) => frame.replace(/\.png$/, "").replace(/_001$/, "");

// One row per object, columns in the order of `columns`, to keep the file small
const columns = ["id", "frame", "tab", "type", "class", "w", "h", "zLayer", "zOrder"];
const rows = dump.result.objects.map((o) => [
  o.id,
  frameName(o.frame),
  o.tab ?? -1,
  o.type,
  className(o.class),
  o.w,
  o.h,
  o.zLayer,
  o.zOrder,
]);

const dest = join(dirname(fileURLToPath(import.meta.url)), "../src/data/objects.json");
writeFileSync(dest, JSON.stringify({ columns, rows }) + "\n");
console.error(`wrote ${rows.length} objects to ${dest}`);
