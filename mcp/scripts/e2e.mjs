// End-to-end check against a running game: MCP client -> stdio server -> mod -> editor.
//
// Start Geometry Dash with the mod installed and leave it in the menus (no
// level open), then run `npm run e2e`. Everything happens in a temporary
// scratch level that is never saved; none of the user's levels are touched.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
const step = (label) => console.log("ok  " + label);

// Returns once the editor is ready, so the next call can follow immediately
const opened = await call("gd_open_level", { scratch: true });
assert.equal(opened.level.name, "Scratch");
step("opened a scratch level");

// Ground row, a spike on top, a trigger high up
const ground = Array.from({ length: 10 }, (_, n) => ({ id: 1, x: 15 + 30 * n, y: 15 }));
await call("gd_place_objects", { objects: [...ground, { id: 8, x: 195, y: 45 }, { id: 901, x: 315, y: 195, props: { targetGroupID: 1 } }] });

let info = await call("gd_get_level_info");
assert.deepEqual(info.bounds, { x1: 15, y1: 15, x2: 315, y2: 195 });
step("bounds are in level coordinates " + JSON.stringify(info.bounds));
assert.deepEqual(info.groupsInUse, [[1, 1]]);
assert.equal(info.nextFreeGroup, 2);
step("a trigger's target group counts as in use; next free group is 2");

let area = await call("gd_get_objects", { area: { x1: 0, y1: 0, x2: 300, y2: 30 } });
assert.equal(area.total, 10);
assert.ok(area.objects.every((o) => o.id === 1 && o.y === 15));
area = await call("gd_get_objects", { area: { x1: 180, y1: 31, x2: 210, y2: 60 } });
assert.deepEqual(area.objects.map((o) => o.id), [8]);
step("area filter selects by level coordinates");

let camera = await call("gd_set_camera", { x: 300, y: 100, zoom: 0.8 });
assert.deepEqual([camera.x, camera.y, camera.zoom], [300, 100, 0.8]);
camera = (await call("gd_get_level_info")).camera;
assert.deepEqual([camera.x, camera.y, camera.zoom], [300, 100, 0.8]);
step("camera round-trips " + JSON.stringify(camera));

// Following: place something far away and the view should centre on it
await call("gd_place_objects", { objects: [{ id: 1, x: 3015, y: 315 }] });
camera = (await call("gd_get_level_info")).camera;
assert.deepEqual([camera.x, camera.y], [3015, 315]);
step("view follows objects placed off screen");
// ...and stays put for objects already visible
await call("gd_place_objects", { objects: [{ id: 1, x: 3045, y: 315 }] });
camera = (await call("gd_get_level_info")).camera;
assert.deepEqual([camera.x, camera.y], [3015, 315]);
step("view stays put for objects already on screen");

// Rotation around an explicit pivot: (3045, 315) turned 90 degrees clockwise about (3015, 315) lands below it
const far = (await call("gd_get_objects", { area: { x1: 3040, y1: 310, x2: 3050, y2: 320 } })).objects[0];
await call("gd_transform_objects", { uids: [far.uid], rotate: 90, pivot: { x: 3015, y: 315 } });
const turned = (await call("gd_get_objects", { uids: [far.uid] })).objects[0];
assert.deepEqual([turned.x, turned.y, turned.rotation], [3015, 285, 90]);
step("pivot is in level coordinates; uid survived the transform");

// Bulk: 2,000 objects in one call
const t0 = Date.now();
const fill = await call("gd_fill_area", { id: 1, x1: 4005, y1: 15, x2: 4005 + 30 * 49, y2: 15 + 30 * 39, follow: false });
assert.equal(fill.placed, 2000);
assert.deepEqual(fill.uidRanges.length, 1);
step(`placed 2000 objects in ${Date.now() - t0} ms as one undo step, uids ${JSON.stringify(fill.uidRanges)}`);
const before = (await call("gd_get_level_info")).level.objectCount;
await call("gd_undo");
assert.equal((await call("gd_get_level_info")).level.objectCount, before - 2000);
step("one undo removed all 2000");

// Paging
await call("gd_redo");
const page = await call("gd_get_objects", { ids: [1], limit: 500, offset: 1500 });
assert.equal(page.objects.length, 500);
assert.equal(page.nextOffset, 2000);
step(`paging works (total ${page.total})`);

// Editing the selection the user made
const two = (await call("gd_get_objects", { area: { x1: 0, y1: 0, x2: 50, y2: 30 } })).objects.map((o) => o.uid);
await call("gd_select_objects", { uids: two });
const edit = await call("gd_edit_objects", { selected: true, set: { color1: 5, zLayer: "T2" }, addGroups: [9] });
assert.equal(edit.edited, 2);
const sel = await call("gd_get_objects", { selected: true });
assert.equal(sel.total, 2);
assert.ok(sel.objects.every((o) => o.color1 === 5 && o.zLayer === "T2" && o.groups.includes(9)));
step("edited the selection and it stayed selected");
await call("gd_select_objects", { uids: [] });

const describe = await call("gd_describe_object", { id: 1268 });
assert.equal(Object.keys(describe.props)[0], "SpawnTriggerGameObject");
step("describe lists a spawn trigger's own properties first: " + Object.keys(describe.props.SpawnTriggerGameObject).join(", "));

console.log("\nALL CHECKS PASSED");
await client.close();
