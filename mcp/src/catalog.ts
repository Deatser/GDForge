// Every object the game can place, as dumped from the game itself (see
// scripts/gen-catalog.mjs). This is what lets an assistant turn "a yellow orb"
// into object ID 36 without the game running.

import data from "./data/objects.json" with { type: "json" };
import { CATEGORIES, OBJECT_NAMES, OBJECT_TYPES } from "./names.js";

export interface CatalogEntry {
  id: number;
  name: string;
  // Sprite frame, the game's internal name for the object's look
  frame: string;
  // Build tab the object is found in; "other" if it has no button
  category: string;
  // The game's gameplay classification: solid, hazard, decoration, slope, trigger, ...
  type: string;
  // C++ class, which decides the properties the object accepts
  className: string;
  // Sprite size in level units (a grid cell is 30)
  width: number;
  height: number;
}

type Row = [
  id: number,
  frame: string,
  tab: number,
  type: number,
  className: string,
  w: number,
  h: number,
  zLayer: number,
  zOrder: number,
];

// "edit_eMoveComBtn" -> "Move Com", "spike_01" -> "spike 01"
function nameFromFrame(frame: string): string {
  const trigger = frame.match(/^edit_e(.+?)(Btn)?$/);
  const base = trigger ? trigger[1]! : frame;
  return base
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

const entries: CatalogEntry[] = (data.rows as unknown as Row[]).map(([id, frame, tab, type, className, w, h]) => ({
  id,
  name: OBJECT_NAMES[id] ?? nameFromFrame(frame),
  frame,
  category: CATEGORIES[tab] ?? "other",
  type: OBJECT_TYPES[type] ?? `type ${type}`,
  className,
  width: w,
  height: h,
}));

const byId = new Map(entries.map((entry) => [entry.id, entry]));

export function lookupObject(id: number): CatalogEntry | undefined {
  return byId.get(id);
}

export interface SearchOptions {
  query?: string;
  category?: string;
  type?: string;
  limit?: number;
}

export interface SearchResult {
  total: number;
  objects: CatalogEntry[];
}

// Finds objects whose name, frame, category, type or class contain every word
// of the query. Objects with a curated name that matches rank first, since
// those are the ones people mean by "spike" or "cube portal".
export function searchObjects({ query = "", category, type, limit = 30 }: SearchOptions): SearchResult {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of entries) {
    if (category && entry.category !== category.toLowerCase()) continue;
    if (type && !entry.type.includes(type.toLowerCase())) continue;

    const name = entry.name.toLowerCase();
    const haystack = `${entry.id} ${name} ${entry.frame} ${entry.category} ${entry.type} ${entry.className}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;

    let score = 0;
    if (words.length > 0) {
      if (words.includes(String(entry.id))) score += 8;
      if (words.every((word) => name.includes(word))) score += 2;
      if (entry.id in OBJECT_NAMES) score += 4;
    }
    scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
  return { total: scored.length, objects: scored.slice(0, limit).map((s) => s.entry) };
}

export function categoryNames(): string[] {
  return [...CATEGORIES, "other"];
}
