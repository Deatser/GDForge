import assert from "node:assert/strict";
import { test } from "node:test";

import { lookupObject, searchObjects } from "./catalog.js";
import { schemaFor, searchProperties } from "./schema.js";

test("knows the classics by ID", () => {
  assert.deepEqual(
    [1, 8, 12, 36, 901].map((id) => lookupObject(id)?.type),
    ["solid", "hazard", "cube portal", "yellow jump orb", "trigger"],
  );
  assert.equal(lookupObject(1)?.category, "blocks");
  assert.equal(lookupObject(901)?.category, "triggers");
  assert.equal(lookupObject(999999), undefined);
});

test("finds objects by what people call them", () => {
  const first = (query: string) => searchObjects({ query }).objects[0]?.id;
  assert.equal(first("spike"), 8);
  assert.equal(first("cube portal"), 12);
  assert.equal(first("yellow orb"), 36);
  assert.equal(first("move trigger"), 901);
  assert.equal(first("901"), 901);
});

test("filters by category and type", () => {
  const hazards = searchObjects({ type: "hazard", limit: 200 });
  assert.ok(hazards.total > 50);
  assert.ok(hazards.objects.every((object) => object.type.includes("hazard")));

  const triggers = searchObjects({ category: "triggers", limit: 200 });
  assert.ok(triggers.objects.some((object) => object.id === 1268));
  assert.equal(searchObjects({ query: "no such object anywhere" }).total, 0);
});

test("every object's class has a property schema", () => {
  const { objects } = searchObjects({ limit: 100000 });
  assert.ok(objects.length > 4000);
  for (const object of objects) assert.equal(schemaFor(object.className).className, object.className);
});

test("a trigger inherits the properties of its base classes", () => {
  const names = schemaFor(lookupObject(1268)!.className)
    .properties()
    .map((property) => property.name);
  // Its own, from EffectGameObject, and from GameObject
  for (const name of ["spawnDelay", "targetGroupID", "noTouch"]) assert.ok(names.includes(name), name);
  // Fields exposed at the top level of an object are not repeated as props
  for (const name of ["groups", "scaleX", "zOrder"]) assert.ok(!names.includes(name), name);
});

test("finds properties by name or key", () => {
  assert.ok(searchProperties("duration").some((property) => property.key === 10));
  assert.equal(schemaFor(lookupObject(1268)!.className).properties()[0]?.className, "SpawnTriggerGameObject");
  assert.deepEqual(
    searchProperties("51").map((property) => property.name),
    ["targetGroupID"],
  );
});
