// Names and types for the numeric keys of the save format, per kind of object.
//
// The table in data/properties.json is generated from the game's class layout
// (see scripts/gen-properties.mjs): every class lists the keys it saves and
// the member each one is stored in. An object's properties are those of its
// class plus all its base classes.

import data from "./data/properties.json" with { type: "json" };

export type ValueType = "bool" | "int" | "float" | "string" | "raw";

export interface Property {
  key: number;
  name: string;
  type: ValueType;
  // The class that declares it; base classes hold what related objects share
  className: string;
}

interface ClassData {
  parent: string | null;
  props: Record<string, [name: string, type: string]>;
}

const classes = data.classes as unknown as Record<string, ClassData>;

export const GD_VERSION: string = data.gdVersion;

// Keys the object model exposes as top-level fields (id, x, y, rotation, ...)
// rather than through `props`. See objects.ts.
export const CORE_KEYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 20, 21, 22, 24, 25, 32, 57, 61, 128, 129]);

// m_isTouchTriggered -> touchTriggered, m_hasNoGlow -> noGlow: closer to the labels in the editor
function prettyName(member: string): string {
  const stripped = member.replace(/^is(?=[A-Z])/, "").replace(/^has(?=No[A-Z])/, "");
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

// Names are matched loosely: target_group_id, TargetGroupId and targetGroupID are the same
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

class PropertyTable {
  private readonly byKey = new Map<number, Property>();
  private readonly byName = new Map<string, Property>();

  // Classes are given most derived first, so a subclass wins a name clash
  constructor(classNames: string[]) {
    for (const className of classNames) {
      for (const [keyText, [member, type]] of Object.entries(classes[className]?.props ?? {})) {
        const key = Number(keyText);
        if (CORE_KEYS.has(key) || this.byKey.has(key)) continue;

        let name = prettyName(member);
        if (this.byName.has(normalize(name))) name += key;
        const property: Property = { key, name, type: type as ValueType, className };
        this.byKey.set(key, property);
        this.byName.set(normalize(name), property);
        // Also accept the member's own spelling, e.g. isTouchTriggered
        if (!this.byName.has(normalize(member))) this.byName.set(normalize(member), property);
      }
    }
  }

  forKey(key: number): Property | undefined {
    return this.byKey.get(key);
  }

  forName(name: string): Property | undefined {
    return this.byName.get(normalize(name));
  }

  // In the order the classes were given
  all(): Property[] {
    return [...this.byKey.values()];
  }
}

function chainOf(className: string): string[] {
  const chain: string[] = [];
  for (let cls: string | null = className; cls && classes[cls]; cls = classes[cls]!.parent) chain.push(cls);
  return chain;
}

// Every known key, for objects whose class does not list it. The common base
// classes go first so that their names win.
const globalTable = new PropertyTable([
  "GameObject",
  "EnhancedGameObject",
  "EffectGameObject",
  ...Object.keys(classes).sort(),
]);

// Maps between save-string keys and property names for objects of one class.
export class Schema {
  private readonly own: PropertyTable;

  constructor(readonly className: string) {
    this.own = new PropertyTable(chainOf(className));
  }

  // The property a key decodes to, if it has a known name.
  forKey(key: number): Property | undefined {
    const own = this.own.forKey(key);
    if (own) return own;
    const global = globalTable.forKey(key);
    // A borrowed name must not read back as one of this class's own properties
    if (global && !this.own.forName(global.name)) return global;
    return undefined;
  }

  // The property a name or numeric key given by the caller refers to.
  resolve(name: string): Property | undefined {
    if (/^\d+$/.test(name)) {
      const key = Number(name);
      return this.forKey(key) ?? { key, name, type: "raw", className: this.className };
    }
    return this.own.forName(name) ?? globalTable.forName(name);
  }

  // The properties objects of this class save, beyond the common top-level
  // fields: its own first, then those of each base class.
  properties(): Property[] {
    return this.own.all();
  }
}

const schemas = new Map<string, Schema>();

export function schemaFor(className: string | undefined): Schema {
  const name = className && classes[className] ? className : "GameObject";
  let schema = schemas.get(name);
  if (!schema) schemas.set(name, (schema = new Schema(name)));
  return schema;
}

// Properties whose name contains the query, across all kinds of object.
export function searchProperties(query: string): Property[] {
  const needle = normalize(query);
  const found: Property[] = [];
  for (const className of Object.keys(classes).sort()) {
    for (const [keyText, [member, type]] of Object.entries(classes[className]!.props)) {
      const name = prettyName(member);
      if (keyText === query || normalize(name).includes(needle)) {
        found.push({ key: Number(keyText), name, type: type as ValueType, className });
      }
    }
  }
  return found.sort((a, b) => a.key - b.key);
}
