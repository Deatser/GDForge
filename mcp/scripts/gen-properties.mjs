// Generates src/data/properties.json from the Geode bindings.
//
// The bindings are the community's reverse-engineered layout of the game's
// classes. Members are annotated with the save-string key they are serialized
// under ("// property 51" above "int m_targetGroupID;"), which gives a
// key -> meaning table per class, straight from the game's own structure.
//
// Usage: node scripts/gen-properties.mjs <path to bindings/<gd version>/GeometryDash.bro>
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const broPath = process.argv[2];
if (!broPath) {
  console.error("usage: node scripts/gen-properties.mjs <GeometryDash.bro>");
  process.exit(1);
}

const ROOT = "GameObject";
const lines = readFileSync(broPath, "utf8").split("\n");

/** @type {Record<string, string | null>} */
const parents = {};
/** @type {Record<string, Record<string, [string, string]>>} */
const props = {};
let current = null;

// How a value is written in a save string, judged from the member's C++ type
function valueType(cppType) {
  const type = cppType.replace(/\bconst\b|\bunsigned\b/g, "").trim();
  if (type === "bool") return "bool";
  if (/^(int|short|char|long)$/.test(type)) return "int";
  if (/^(float|double)$/.test(type)) return "float";
  if (type === "gd::string") return "string";
  // Enums are plain identifiers and are saved as their integer value
  if (/^[A-Z]\w*$/.test(type)) return "int";
  // Colours, HSV, vectors and the like have their own text encodings
  return "raw";
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const cls = line.match(/^class\s+([\w:]+)\s*(?::\s*([\w:]+))?/);
  if (cls) {
    current = cls[1];
    parents[current] = cls[2] ?? null;
    continue;
  }
  if (!current || !/\/\/\s*property\s+\d+/i.test(line)) continue;
  const keys = [...line.matchAll(/property\s+(\d+)/gi)].map((m) => m[1]);

  // The annotated member is the next line that is neither blank nor a comment
  let j = i + 1;
  while (j < lines.length && (/^\s*\/\//.test(lines[j]) || !lines[j].trim())) j++;
  const decl = lines[j]?.match(/^\s*(.+?)\s*\*?\s*\bm_(\w+)\s*;/);
  if (!decl) continue;
  const [, cppType, member] = decl;
  // Placeholder names such as m_property310 carry no meaning
  if (/^property\d+$/.test(member)) continue;

  keys.forEach((key, index) => {
    // "property 28, property 29" above a CCPoint: first key is x, second is y
    const name = keys.length > 1 ? member + (index === 0 ? "X" : "Y") : member;
    const type = keys.length > 1 ? "float" : valueType(cppType);
    (props[current] ??= {})[key] = [name, type];
  });
}

function descendsFromRoot(name) {
  for (let cls = name; cls; cls = parents[cls]) {
    if (cls === ROOT) return true;
  }
  return false;
}

const classes = {};
for (const name of Object.keys(parents).sort()) {
  if (!descendsFromRoot(name)) continue;
  classes[name] = {
    parent: name === ROOT ? null : parents[name],
    props: props[name] ?? {},
  };
}

const out = {
  // bindings/<version>/GeometryDash.bro
  gdVersion: basename(dirname(broPath)),
  classes,
};
const dest = join(dirname(fileURLToPath(import.meta.url)), "../src/data/properties.json");
writeFileSync(dest, JSON.stringify(out) + "\n");

const count = Object.values(classes).reduce((n, c) => n + Object.keys(c.props).length, 0);
console.error(`wrote ${Object.keys(classes).length} classes, ${count} properties to ${dest}`);
