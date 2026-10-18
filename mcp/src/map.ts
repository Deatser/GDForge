// ASCII map of a level section, one character per grid cell: the cheapest way
// to see a layout. Adapted from GD AI Bridge by RibomDev (MIT, see THIRD_PARTY.md).

import { lookupObject } from "./catalog.js";

export const CELL = 30;

export const MAP_LEGEND =
  "# block, / slope, % breakable, ^ hazard, _ pad, o orb, P portal, > speed or other gameplay modifier, " +
  "$ coin or collectible, = ground, . empty. Column i covers x from x1 + 30*i to x1 + 30*(i+1); row labels are " +
  "the y of the cell centre. Decoration, triggers and objects without collision are left out.";

export interface MapObject {
  id: number;
  x: number;
  y: number;
  noTouch?: boolean;
}

// The character for an object, or undefined if it does not matter for gameplay
export function mapChar(object: MapObject): string | undefined {
  if (object.noTouch) return undefined;
  const entry = lookupObject(object.id);
  if (!entry || entry.category === "triggers") return undefined;
  const type = entry.type;
  if (type === "solid") return "#";
  if (type === "slope") return "/";
  if (type === "breakable") return "%";
  if (type === "hazard" || type === "animated hazard") return "^";
  if (type.endsWith(" pad")) return "_";
  if (type.endsWith(" orb")) return "o";
  if (type.endsWith(" portal")) return "P";
  if (type === "secret coin" || type === "user coin" || type === "collectible") return "$";
  // Speed changers share their type with triggers
  if (type === "trigger") return ">";
  return undefined;
}

// When several objects share a cell, show the one that matters most for gameplay
const PRIORITY: Record<string, number> = { "^": 6, P: 5, o: 4, _: 3, ">": 2, $: 1 };

export function renderMap(objects: MapObject[], x1: number, y1: number, columns: number, rows: number): string {
  const grid = Array.from({ length: rows }, () => Array<string>(columns).fill("."));
  for (const object of objects) {
    const char = mapChar(object);
    if (!char) continue;
    const column = Math.floor((object.x - x1) / CELL);
    const row = Math.floor((object.y - y1) / CELL);
    if (column < 0 || column >= columns || row < 0 || row >= rows) continue;
    const current = grid[row]![column]!;
    if (current === "." || (PRIORITY[char] ?? 0) > (PRIORITY[current] ?? 0)) grid[row]![column] = char;
  }

  // Top row first, each prefixed with the y of its cell centre
  const lines = [];
  for (let row = rows - 1; row >= 0; row--) {
    lines.push(`${String(y1 + row * CELL + CELL / 2).padStart(5)}|${grid[row]!.join("")}`);
  }
  if (y1 <= 0) lines.push(`${"".padStart(5)}|${"=".repeat(columns)}`);
  return lines.join("\n");
}
