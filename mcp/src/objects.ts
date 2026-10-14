// The object model the tools expose, and its translation to and from the
// game's save format.
//
// The fields every object has get a top-level name (id, x, y, rotation,
// groups, ...). Everything else, such as the settings of a trigger, lives in
// `props`, keyed by the property's name when it is known and by its numeric
// save-string key otherwise. Unknown keys always round-trip untouched.

import { lookupObject } from "./catalog.js";
import { type Fields, formatNumber, parseFields, serializeFields } from "./saveString.js";
import { type Property, type Schema, schemaFor } from "./schema.js";

export type PropValue = string | number | boolean;

export interface GDObject {
  // Editor-session handle of a placed object. Absent on objects not placed yet.
  uid?: number;
  id: number;
  x: number;
  y: number;
  rotation?: number;
  // Uniform scale. When the axes differ, scaleX and scaleY are used instead.
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  flipX?: boolean;
  flipY?: boolean;
  groups?: number[];
  // Colour channel IDs of the base and detail colour
  color1?: number;
  color2?: number;
  zLayer?: string | number;
  zOrder?: number;
  editorLayer?: number;
  editorLayer2?: number;
  props?: Record<string, PropValue>;
}

// Changes to apply to an object: any field of GDObject, null to clear one.
export type ObjectPatch = {
  [K in Exclude<keyof GDObject, "uid" | "props">]?: GDObject[K] | null;
} & {
  props?: Record<string, PropValue | null>;
  addGroups?: number[];
  removeGroups?: number[];
};

const KEY = {
  id: 1,
  x: 2,
  y: 3,
  flipX: 4,
  flipY: 5,
  rotation: 6,
  editorLayer: 20,
  color1: 21,
  color2: 22,
  zLayer: 24,
  zOrder: 25,
  text: 31,
  legacyScale: 32,
  groups: 57,
  editorLayer2: 61,
  scaleX: 128,
  scaleY: 129,
} as const;

const MAX_GROUPS_PER_OBJECT = 10;
const MAX_GROUP_ID = 9999;

// B = behind the player, T = in front; higher numbers are further from the player's layer
const Z_LAYERS: Record<string, number> = { B5: -5, B4: -3, B3: -1, B2: 1, B1: 3, T1: 5, T2: 7, T3: 9, T4: 11 };
const Z_LAYER_NAMES = new Map(Object.entries(Z_LAYERS).map(([name, value]) => [value, name]));

function schemaForId(id: number): Schema {
  return schemaFor(lookupObject(id)?.className);
}

// Text objects store their text base64url-encoded
function decodeText(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function encodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeValue(property: Property, raw: string): PropValue {
  if (property.key === KEY.text) return decodeText(raw);
  switch (property.type) {
    case "bool":
      return raw === "1";
    case "int":
    case "float": {
      const value = Number(raw);
      return Number.isFinite(value) ? value : raw;
    }
    default:
      return raw;
  }
}

// The text a value is saved as, or null if the key should be left out.
function encodeValue(property: Property, value: PropValue): string | null {
  if (property.key === KEY.text) return encodeText(String(value));
  if (typeof value === "boolean") return value ? "1" : null;
  if (property.type === "bool") return value === 0 || value === "0" || value === "" ? null : "1";
  if (typeof value === "number") {
    if (property.type === "int" && !Number.isInteger(value)) {
      throw new Error(`Property "${property.name}" takes a whole number, got ${value}`);
    }
    return formatNumber(value);
  }
  return value;
}

function parseGroups(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw.split(".").map(Number).filter(Number.isInteger);
}

function parseZLayer(value: string | number): number {
  if (typeof value === "number") return value;
  const layer = Z_LAYERS[value.toUpperCase()];
  if (layer === undefined) {
    throw new Error(`Unknown zLayer "${value}". Use one of ${Object.keys(Z_LAYERS).join(", ")}.`);
  }
  return layer;
}

function readScale(fields: Fields): { x: number; y: number } {
  const legacy = Number(fields.get(KEY.legacyScale) ?? 1);
  return {
    x: Number(fields.get(KEY.scaleX) ?? legacy),
    y: Number(fields.get(KEY.scaleY) ?? legacy),
  };
}

export function decodeObject(saveString: string, uid?: number): GDObject {
  const fields = parseFields(saveString);
  const id = Number(fields.get(KEY.id));
  const schema = schemaForId(id);

  const object: GDObject = {
    ...(uid !== undefined ? { uid } : {}),
    id,
    x: Number(fields.get(KEY.x) ?? 0),
    y: Number(fields.get(KEY.y) ?? 0),
  };
  const props: Record<string, PropValue> = {};

  for (const [key, raw] of fields) {
    switch (key) {
      case KEY.id:
      case KEY.x:
      case KEY.y:
      case KEY.legacyScale:
      case KEY.scaleX:
      case KEY.scaleY:
        break;
      case KEY.rotation:
        object.rotation = Number(raw);
        break;
      case KEY.flipX:
        if (raw === "1") object.flipX = true;
        break;
      case KEY.flipY:
        if (raw === "1") object.flipY = true;
        break;
      case KEY.groups:
        object.groups = parseGroups(raw);
        break;
      case KEY.color1:
        object.color1 = Number(raw);
        break;
      case KEY.color2:
        object.color2 = Number(raw);
        break;
      case KEY.zLayer:
        object.zLayer = Z_LAYER_NAMES.get(Number(raw)) ?? Number(raw);
        break;
      case KEY.zOrder:
        object.zOrder = Number(raw);
        break;
      case KEY.editorLayer:
        object.editorLayer = Number(raw);
        break;
      case KEY.editorLayer2:
        object.editorLayer2 = Number(raw);
        break;
      default: {
        const property = schema.forKey(key);
        if (property) props[property.name] = decodeValue(property, raw);
        else props[String(key)] = raw;
      }
    }
  }

  const scale = readScale(fields);
  if (scale.x !== scale.y) {
    object.scaleX = scale.x;
    object.scaleY = scale.y;
  } else if (scale.x !== 1) {
    object.scale = scale.x;
  }

  if (Object.keys(props).length > 0) object.props = props;
  return object;
}

function setField(fields: Fields, key: number, value: string | null): void {
  if (value === null) fields.delete(key);
  else fields.set(key, value);
}

// A number field where the default value is simply not saved
function setNumber(fields: Fields, key: number, value: number | null | undefined, fallback = 0): void {
  if (value === undefined) return;
  setField(fields, key, value === null || value === fallback ? null : formatNumber(value));
}

function setFlag(fields: Fields, key: number, value: boolean | null | undefined): void {
  if (value === undefined) return;
  setField(fields, key, value ? "1" : null);
}

function setGroups(fields: Fields, groups: number[]): void {
  const unique = [...new Set(groups)];
  for (const group of unique) {
    if (!Number.isInteger(group) || group < 1 || group > MAX_GROUP_ID) {
      throw new Error(`Group IDs must be whole numbers from 1 to ${MAX_GROUP_ID}, got ${group}`);
    }
  }
  if (unique.length > MAX_GROUPS_PER_OBJECT) {
    throw new Error(`An object can be in at most ${MAX_GROUPS_PER_OBJECT} groups, got ${unique.length}`);
  }
  setField(fields, KEY.groups, unique.length > 0 ? unique.join(".") : null);
}

function applyPatch(fields: Fields, patch: ObjectPatch): void {
  if (patch.id != null) {
    if (!lookupObject(patch.id)) {
      throw new Error(`Unknown object ID ${patch.id}. Use gd_search_objects to find valid IDs.`);
    }
    fields.set(KEY.id, String(patch.id));
  }
  if (patch.x != null) fields.set(KEY.x, formatNumber(patch.x));
  if (patch.y != null) fields.set(KEY.y, formatNumber(patch.y));

  setNumber(fields, KEY.rotation, patch.rotation);
  setFlag(fields, KEY.flipX, patch.flipX);
  setFlag(fields, KEY.flipY, patch.flipY);
  setNumber(fields, KEY.color1, patch.color1);
  setNumber(fields, KEY.color2, patch.color2);
  setNumber(fields, KEY.zOrder, patch.zOrder);
  setNumber(fields, KEY.editorLayer, patch.editorLayer);
  setNumber(fields, KEY.editorLayer2, patch.editorLayer2);
  if (patch.zLayer !== undefined) {
    setNumber(fields, KEY.zLayer, patch.zLayer === null ? null : parseZLayer(patch.zLayer));
  }

  if (patch.scale !== undefined || patch.scaleX !== undefined || patch.scaleY !== undefined) {
    const scale = readScale(fields);
    if (patch.scale !== undefined) scale.x = scale.y = patch.scale ?? 1;
    if (patch.scaleX !== undefined) scale.x = patch.scaleX ?? 1;
    if (patch.scaleY !== undefined) scale.y = patch.scaleY ?? 1;
    // The game writes per-axis scale; the single-value key is from before 2.2
    fields.delete(KEY.legacyScale);
    const unscaled = scale.x === 1 && scale.y === 1;
    setField(fields, KEY.scaleX, unscaled ? null : formatNumber(scale.x));
    setField(fields, KEY.scaleY, unscaled ? null : formatNumber(scale.y));
  }

  if (patch.groups !== undefined || patch.addGroups || patch.removeGroups) {
    let groups = patch.groups === undefined ? parseGroups(fields.get(KEY.groups)) : (patch.groups ?? []);
    if (patch.addGroups) groups = [...groups, ...patch.addGroups];
    if (patch.removeGroups) groups = groups.filter((group) => !patch.removeGroups!.includes(group));
    setGroups(fields, groups);
  }

  if (patch.props) {
    const schema = schemaForId(Number(fields.get(KEY.id)));
    for (const [name, value] of Object.entries(patch.props)) {
      const property = schema.resolve(name);
      if (!property) {
        throw new Error(
          `Unknown property "${name}" for object ID ${fields.get(KEY.id)}. ` +
            "Use gd_describe_object to list the properties it accepts, or pass the numeric key.",
        );
      }
      setField(fields, property.key, value === null ? null : encodeValue(property, value));
    }
  }
}

// The save string of a new object.
export function encodeObject(object: GDObject): string {
  const fields: Fields = new Map();
  applyPatch(fields, object);
  if (!fields.has(KEY.id) || !fields.has(KEY.x) || !fields.has(KEY.y)) {
    throw new Error("An object needs at least id, x and y");
  }
  return serializeFields(fields);
}

// The save string of an existing object with changes applied.
export function patchSaveString(saveString: string, patch: ObjectPatch): string {
  const fields = parseFields(saveString);
  applyPatch(fields, patch);
  return serializeFields(fields);
}
