// The game's object save format: "key,value,key,value" per object, objects
// joined with ";". Key 1 is the object ID, 2 and 3 the position; the rest
// depends on the kind of object. This is exactly what the editor's copy and
// paste use, and what the bridge speaks.

// Insertion-ordered so an untouched object serializes back unchanged
export type Fields = Map<number, string>;

export function parseFields(object: string): Fields {
  const parts = object.split(",");
  const fields: Fields = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = Number(parts[i]);
    if (Number.isInteger(key)) fields.set(key, parts[i + 1]!);
  }
  return fields;
}

export function serializeFields(fields: Fields): string {
  const parts: string[] = [];
  for (const [key, value] of fields) {
    // A stray separator would split the value into bogus fields or objects
    if (/[,;]/.test(value)) {
      throw new Error(`Value of property ${key} must not contain "," or ";": ${value}`);
    }
    parts.push(String(key), value);
  }
  return parts.join(",");
}

export function joinObjects(objects: string[]): string {
  return objects.map((object) => object + ";").join("");
}

// Shortest text for a number, without float noise such as 15.000001
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  return String(Math.round(value * 10000) / 10000);
}
