import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Bridge, BridgeError, type Camera, type EditorInfo, type RawObject, type Status } from "./bridge.js";
import { categoryNames, lookupObject, searchObjects } from "./catalog.js";
import {
  decodeSettings,
  encodeSettings,
  MODES,
  type RawSettings,
  SETTABLE_CHANNELS,
  SPEEDS,
} from "./levelSettings.js";
import { CELL, MAP_LEGEND, type MapObject, renderMap } from "./map.js";
import { decodeObject, decodeRaw, encodeObject, type GDObject, type ObjectPatch, patchSaveString } from "./objects.js";
import { checkInputs, runTest } from "./playtest.js";
import { rgbaToPng } from "./png.js";
import { REFERENCE } from "./reference.js";
import { joinObjects, parseFields } from "./saveString.js";
import { GD_VERSION, schemaFor, searchProperties } from "./schema.js";

const VERSION = "0.3.2";

// The most objects one call may create or rewrite. Keeps a single mistaken
// call from flooding a level, and the request small enough to stay responsive.
const MAX_OBJECTS_PER_CALL = 5000;

const INSTRUCTIONS = `GD Forge controls the Geometry Dash level editor running on the user's computer. Every change shows up in the game immediately and is recorded in the editor's own undo history.

Start with gd_status. A level must be open in the editor for the other editing tools to work.

Coordinates are in level units: one grid cell is 30 units, x grows to the right and y upwards, and the top of the ground is y = 0. Positions are object centres, so a block resting on the ground in column n (counting from 0) is at x = 15 + 30n, y = 15, and the block on top of it at y = 45. Rotation is in degrees clockwise.

Objects are placed by numeric object ID (1 is the default block, 8 a spike). Use gd_search_objects to find IDs rather than guessing, and gd_describe_object to see which properties a trigger accepts.

Every placed object has a uid. A uid stays valid until that object is changed with gd_edit_objects or any undo/redo happens; afterwards read the objects again. gd_transform_objects keeps uids.

Groups are how triggers address objects: put objects in a group, then point a trigger's target group at it. Ask gd_get_level_info for a free group ID before introducing a new one, so existing triggers are not affected.

Work on what the user asked for. In a level that already has content, read the relevant area first and do not delete or rewrite objects you were not asked to change.`;

const OBJECT_MODEL = `Object fields: id (object ID), x, y, rotation, scale (or scaleX/scaleY), flipX, flipY, groups (list of group IDs, max 10), color1/color2 (colour channel IDs of the base/detail colour; 1-999 are custom channels), zLayer (B5..B1 behind the player, T1..T4 in front), zOrder, editorLayer, editorLayer2, and props for everything else. props is keyed by property name (see gd_describe_object) or by the numeric save-string key.`;

type Json = Record<string, unknown>;

function reply(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

// [3940, 3941, 3942, 3950] -> [[3940, 3942], [3950, 3950]]. Batches get consecutive uids, so this stays tiny.
function toRanges(values: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const value of values) {
    const last = ranges[ranges.length - 1];
    if (last && value === last[1] + 1) last[1] = value;
    else ranges.push([value, value]);
  }
  return ranges;
}

function describeUids(uids: number[]): Json {
  return uids.length <= 50 ? { uids } : { uidRanges: toRanges(uids) };
}

const propValue = z.union([z.string(), z.number(), z.boolean()]);

// Fields shared by new objects and by edits to existing ones
const appearance = {
  rotation: z.number().optional().describe("Degrees clockwise"),
  scale: z.number().positive().optional().describe("Uniform scale, 1 is normal size"),
  scaleX: z.number().positive().optional(),
  scaleY: z.number().positive().optional(),
  flipX: z.boolean().optional().describe("Mirror horizontally"),
  flipY: z.boolean().optional().describe("Mirror vertically"),
  groups: z.array(z.number().int()).max(10).optional().describe("Group IDs the object belongs to"),
  color1: z.number().int().optional().describe("Colour channel of the base colour"),
  color2: z.number().int().optional().describe("Colour channel of the detail colour"),
  zLayer: z.union([z.string(), z.number()]).optional().describe("B5, B4, B3, B2, B1, T1, T2, T3 or T4"),
  zOrder: z.number().int().optional(),
  editorLayer: z.number().int().optional(),
  editorLayer2: z.number().int().optional(),
  props: z.record(z.string(), propValue).optional().describe("Other properties by name or numeric key"),
};

const newObject = z.object({
  id: z.number().int().describe("Object ID"),
  x: z.number(),
  y: z.number(),
  ...appearance,
});

const area = z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() });

// The rectangle as the bridge takes it: [left, bottom, right, top]
function toRect({ x1, y1, x2, y2 }: z.infer<typeof area>): number[] {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

// A list of uids, the user's current selection, or everything in an area
const target = {
  uids: z.array(z.number().int()).optional().describe("uids of the objects to act on"),
  selected: z.boolean().optional().describe("Act on the objects currently selected in the editor instead"),
  area: area.optional().describe("Act on every object whose centre lies in this rectangle instead, triggers included"),
};

interface Target {
  uids?: number[] | undefined;
  selected?: boolean | undefined;
  area?: z.infer<typeof area> | undefined;
}

export function createServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "gdforge", version: VERSION }, { instructions: INSTRUCTIONS });

  // Registers a tool whose handler returns plain data and may throw.
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape; annotations?: ToolAnnotations },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ): void {
    server.registerTool(name, config, (async (args: z.infer<z.ZodObject<Shape>>) => {
      try {
        return reply(await handler(args));
      } catch (error) {
        return failure(error);
      }
    }) as never);
  }

  async function fetchObjects(filter: Json): Promise<{ total: number; objects: RawObject[] }> {
    return bridge.call("objects.get", filter);
  }

  // The objects a tool should act on, as the game currently has them.
  async function resolveTarget({ uids, selected, area }: Target): Promise<RawObject[]> {
    if (selected) return (await fetchObjects({ selected: true, limit: MAX_OBJECTS_PER_CALL + 1 })).objects;
    if (uids && uids.length > 0) return (await fetchObjects({ uids, limit: uids.length })).objects;
    if (area) {
      const { total, objects } = await fetchObjects({ rect: toRect(area), limit: MAX_OBJECTS_PER_CALL + 1 });
      checkBatchSize(total);
      return objects;
    }
    throw new Error("Pass uids, selected: true to use the editor's selection, or an area.");
  }

  // The game fades into the editor for about half a second after a level is opened.
  async function waitForEditor(): Promise<EditorInfo> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bridge.call<EditorInfo>("editor.info");
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "busy" || attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  function checkBatchSize(count: number): void {
    if (count > MAX_OBJECTS_PER_CALL) {
      throw new Error(`That is ${count} objects; one call can handle at most ${MAX_OBJECTS_PER_CALL}. Split the work up.`);
    }
  }

  // Moves the view to newly placed objects when they would otherwise be off screen.
  async function followObjects(objects: Array<{ x: number; y: number }>): Promise<void> {
    const xs = objects.map((object) => object.x);
    const ys = objects.map((object) => object.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

    const { camera } = await bridge.call<EditorInfo>("editor.info");
    const visible =
      minX >= camera.x - camera.viewWidth / 2 &&
      maxX <= camera.x + camera.viewWidth / 2 &&
      minY >= camera.y - camera.viewHeight / 2 &&
      maxY <= camera.y + camera.viewHeight / 2;
    if (!visible) await bridge.call("editor.camera", { x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  }

  async function place(objects: GDObject[], options: { select?: boolean | undefined; follow?: boolean | undefined }) {
    checkBatchSize(objects.length);
    const data = joinObjects(objects.map(encodeObject));
    const { uids } = await bridge.call<{ uids: number[] }>("objects.add", { data, select: options.select ?? false });
    if (options.follow ?? true) await followObjects(objects);
    return { placed: uids.length, ...describeUids(uids) };
  }

  tool(
    "gd_status",
    {
      title: "Game status",
      description:
        "Check the connection to Geometry Dash and whether a level is open in the editor. Call this first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const status = await bridge.call<Status>("status");
      return {
        ...status,
        catalogGdVersion: GD_VERSION,
        ...(status.editor ? {} : { hint: "No level is open in the editor. Ask the user to open one, or use gd_open_level." }),
      };
    },
  );

  tool(
    "gd_list_levels",
    {
      title: "List created levels",
      description: "List the user's own created levels, with the index gd_open_level takes.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => bridge.call("levels.list"),
  );

  tool(
    "gd_open_level",
    {
      title: "Open a level in the editor",
      description:
        "Open the level editor from the game's menus. Pass exactly one of: index (one of the user's created levels, " +
        "from gd_list_levels), create (name of a new level to add to their list), or scratch (a temporary level that " +
        "is never saved, for experiments). Fails if a level is already open; the user has to exit it first. " +
        "Only open one of the user's existing levels when they asked for that level.",
      inputSchema: {
        index: z.number().int().min(0).optional(),
        create: z.string().min(1).max(20).optional(),
        scratch: z.boolean().optional(),
      },
    },
    async ({ index, create, scratch }) => {
      const chosen = [index !== undefined, create !== undefined, scratch === true].filter(Boolean).length;
      if (chosen !== 1) throw new Error("Pass exactly one of index, create or scratch.");
      await bridge.call("levels.open", { index, create, scratch });
      return waitForEditor();
    },
  );

  tool(
    "gd_get_level_info",
    {
      title: "Level overview",
      description:
        "Overview of the level open in the editor: name, object count, bounds, the view, which object IDs it uses most, " +
        "which groups and colour channels are in use, and a free group ID. Cheap even for huge levels; " +
        "use it before reading objects.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const info = await bridge.call<EditorInfo>("editor.info");
      const summary = await bridge.call<{
        bounds: number[];
        countById: Array<[number, number]>;
        groups: number[];
        colors: number[];
      }>("objects.summary");

      const used = new Set(summary.groups);
      let nextFreeGroup = 1;
      while (used.has(nextFreeGroup)) nextFreeGroup++;

      const mostUsed = summary.countById
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([id, count]) => ({ id, name: lookupObject(id)?.name ?? "unknown", count }));

      const [x1, y1, x2, y2] = summary.bounds;
      return {
        ...info,
        bounds: summary.bounds.length === 4 ? { x1, y1, x2, y2 } : null,
        distinctObjectIds: summary.countById.length,
        mostUsedObjects: mostUsed,
        // Assigned to objects, or targeted by a trigger's target/centre group
        groupsInUse: toRanges(summary.groups),
        nextFreeGroup,
        colorChannelsInUse: toRanges(summary.colors),
      };
    },
  );

  tool(
    "gd_get_objects",
    {
      title: "Read objects",
      description:
        "Read objects from the open level, left to right. All filters are optional and combine. " +
        `Returns at most "limit" objects plus the total that matched; page with offset. ${OBJECT_MODEL}`,
      inputSchema: {
        uids: z.array(z.number().int()).optional(),
        ids: z.array(z.number().int()).optional().describe("Only these object IDs"),
        area: z
          .object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })
          .optional()
          .describe("Only objects whose centre lies in this rectangle"),
        group: z.number().int().optional().describe("Only objects in this group"),
        editorLayer: z.number().int().optional(),
        selected: z.boolean().optional().describe("Only the objects selected in the editor"),
        limit: z.number().int().min(1).max(2000).optional().describe("Default 200"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ uids, ids, area, group, editorLayer, selected, limit = 200, offset = 0 }) => {
      const { total, objects } = await fetchObjects({
        uids,
        ids,
        rect: area && [
          Math.min(area.x1, area.x2),
          Math.min(area.y1, area.y2),
          Math.max(area.x1, area.x2),
          Math.max(area.y1, area.y2),
        ],
        group,
        layer: editorLayer,
        selected,
        limit,
        offset,
      });
      const next = offset + objects.length;
      return {
        total,
        ...(next < total ? { nextOffset: next } : {}),
        objects: objects.map(decodeRaw),
      };
    },
  );

  tool(
    "gd_place_objects",
    {
      title: "Place objects",
      description:
        "Place new objects in the open level, as one undo step. Send everything that belongs together in one call. " +
        `"defaults" are fields applied to every object that does not set them itself. ${OBJECT_MODEL}`,
      inputSchema: {
        objects: z.array(newObject).min(1).max(MAX_OBJECTS_PER_CALL),
        defaults: z.object(appearance).optional(),
        select: z.boolean().optional().describe("Leave the new objects selected in the editor. Default false."),
        follow: z
          .boolean()
          .optional()
          .describe("Move the editor view to the new objects if they are off screen. Default true."),
      },
    },
    async ({ objects, defaults, select, follow }) => {
      const merged = objects.map((object) => ({
        ...defaults,
        ...object,
        ...(defaults?.props || object.props ? { props: { ...defaults?.props, ...object.props } } : {}),
      }));
      return place(merged as GDObject[], { select, follow });
    },
  );

  tool(
    "gd_fill_area",
    {
      title: "Fill an area with one object",
      description:
        "Place the same object on a regular grid covering a rectangle, as one undo step. " +
        "x1,y1 and x2,y2 are the centres of two opposite corner objects. With hollow, only the border is placed.",
      inputSchema: {
        id: z.number().int().describe("Object ID"),
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        stepX: z.number().positive().optional().describe("Horizontal spacing, default 30 (one grid cell)"),
        stepY: z.number().positive().optional().describe("Vertical spacing, default 30"),
        hollow: z.boolean().optional(),
        ...appearance,
        follow: z.boolean().optional(),
      },
    },
    async ({ id, x1, y1, x2, y2, stepX = 30, stepY = 30, hollow, follow, ...fields }) => {
      const [left, right] = [Math.min(x1, x2), Math.max(x1, x2)];
      const [bottom, top] = [Math.min(y1, y2), Math.max(y1, y2)];
      // Rounding absorbs float error so that a span of exactly n steps yields n + 1 objects
      const columns = Math.floor((right - left) / stepX + 1e-6) + 1;
      const rows = Math.floor((top - bottom) / stepY + 1e-6) + 1;
      checkBatchSize(hollow ? 2 * (columns + rows) : columns * rows);

      const objects: GDObject[] = [];
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const border = row === 0 || row === rows - 1 || column === 0 || column === columns - 1;
          if (hollow && !border) continue;
          objects.push({ ...fields, id, x: left + column * stepX, y: bottom + row * stepY } as GDObject);
        }
      }
      return { columns, rows, ...(await place(objects, { follow })) };
    },
  );

  tool(
    "gd_line",
    {
      title: "Place objects along a line",
      description:
        "Place the same object along a straight line, e.g. a row of spikes or a diagonal of orbs, as one undo step. " +
        "x1,y1 and x2,y2 are the centres of the first and last object. Give step (spacing) or count (objects, " +
        "evenly spaced), not both.",
      inputSchema: {
        id: z.number().int().describe("Object ID"),
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number().optional().describe("Default y1, a horizontal line"),
        step: z.number().positive().optional().describe("Spacing along the line, default 30 (one grid cell)"),
        count: z.number().int().min(1).optional(),
        ...appearance,
        follow: z.boolean().optional(),
      },
    },
    async ({ id, x1, y1, x2, y2 = y1, step, count, follow, ...fields }) => {
      if (step !== undefined && count !== undefined) throw new Error("Give step or count, not both.");
      const length = Math.hypot(x2 - x1, y2 - y1);
      const spacing = step ?? 30;
      // Rounding absorbs float error so that a length of exactly n steps yields n + 1 objects
      const total = count ?? Math.floor(length / spacing + 1e-6) + 1;
      checkBatchSize(total);
      const objects: GDObject[] = [];
      for (let i = 0; i < total; i++) {
        // count spreads the objects from end to end; a step keeps exact spacing and may stop short of x2,y2
        const along =
          count !== undefined ? (total === 1 ? 0 : i / (total - 1)) : length === 0 ? 0 : (i * spacing) / length;
        objects.push({ ...fields, id, x: x1 + (x2 - x1) * along, y: y1 + (y2 - y1) * along } as GDObject);
      }
      return place(objects, { follow });
    },
  );

  tool(
    "gd_copy",
    {
      title: "Copy objects with an offset",
      description:
        "Duplicate objects shifted by dx,dy, as one undo step; times repeats it, each copy shifted by dx,dy further. " +
        "Good for repeating a pattern. Copies keep every property, groups included, so triggers that target those " +
        "groups act on the copies too.",
      inputSchema: {
        ...target,
        dx: z.number(),
        dy: z.number().optional().describe("Default 0"),
        times: z.number().int().min(1).max(100).optional().describe("Default 1"),
        follow: z.boolean().optional(),
      },
    },
    async ({ uids, selected, area, dx, dy = 0, times = 1, follow }) => {
      const objects = await resolveTarget({ uids, selected, area });
      if (objects.length === 0) return { copied: 0, note: "No matching objects." };
      checkBatchSize(objects.length * times);
      const copies: string[] = [];
      const positions: Array<{ x: number; y: number }> = [];
      for (let t = 1; t <= times; t++) {
        for (const [, saveString] of objects) {
          const { x, y } = decodeObject(saveString);
          const position = { x: x + dx * t, y: y + dy * t };
          copies.push(patchSaveString(saveString, position));
          positions.push(position);
        }
      }
      const { uids: placed } = await bridge.call<{ uids: number[] }>("objects.add", {
        data: joinObjects(copies),
        select: false,
      });
      if (follow ?? true) await followObjects(positions);
      return { placed: placed.length, ...describeUids(placed) };
    },
  );

  tool(
    "gd_map",
    {
      title: "ASCII map of an area",
      description:
        "Draw a level area as text, one character per grid cell, showing only what matters for gameplay " +
        "(blocks, slopes, hazards, pads, orbs, portals, coins). The cheapest way to see a layout. Default: 60 x 12 " +
        "cells from x1 = 0, y1 = 0.",
      inputSchema: {
        x1: z.number().optional().describe("Left edge, default 0"),
        y1: z.number().optional().describe("Bottom edge, default 0 (the ground)"),
        x2: z.number().optional().describe("Right edge, default x1 + 1800 (60 cells)"),
        y2: z.number().optional().describe("Top edge, default y1 + 360 (12 cells)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ x1 = 0, y1 = 0, x2 = x1 + 60 * CELL, y2 = y1 + 12 * CELL }) => {
      const columns = Math.ceil((x2 - x1) / CELL);
      const rows = Math.ceil((y2 - y1) / CELL);
      if (columns <= 0 || rows <= 0) throw new Error("The area is empty: x2 and y2 must be greater than x1 and y1.");
      if (columns > 300 || rows > 80) throw new Error("The area is too big: at most 300 x 80 cells.");

      const objects: MapObject[] = [];
      for (let offset = 0; ; ) {
        const page = await fetchObjects({ rect: [x1, y1, x2, y2], limit: 2000, offset });
        for (const [, saveString, liveX, liveY] of page.objects) {
          const fields = parseFields(saveString);
          objects.push({
            id: Number(fields.get(1)),
            x: liveX ?? Number(fields.get(2)),
            y: liveY ?? Number(fields.get(3)),
            noTouch: fields.get(121) === "1",
          });
        }
        offset += page.objects.length;
        if (page.objects.length === 0 || offset >= page.total) break;
      }
      return { x1, y1, cell: CELL, legend: MAP_LEGEND, map: renderMap(objects, x1, y1, columns, rows) };
    },
  );

  tool(
    "gd_edit_objects",
    {
      title: "Change object properties",
      description:
        'Change properties of existing objects. "set" takes the same fields as a new object (all optional); ' +
        "a field or prop set to null is cleared. addGroups/removeGroups change group membership without touching " +
        "the other groups. The game rebuilds edited objects, so they get NEW uids (returned in the same order) " +
        "and the edit is two undo steps. To only move, rotate, scale or flip, use gd_transform_objects instead: " +
        `it keeps uids. ${OBJECT_MODEL}`,
      inputSchema: {
        ...target,
        set: z
          .object({
            id: z.number().int().nullable().optional().describe("Swap the object for another object ID"),
            x: z.number().nullable().optional(),
            y: z.number().nullable().optional(),
            rotation: z.number().nullable().optional(),
            scale: z.number().positive().nullable().optional(),
            scaleX: z.number().positive().nullable().optional(),
            scaleY: z.number().positive().nullable().optional(),
            flipX: z.boolean().nullable().optional(),
            flipY: z.boolean().nullable().optional(),
            groups: z.array(z.number().int()).max(10).nullable().optional().describe("Replaces all groups"),
            color1: z.number().int().nullable().optional(),
            color2: z.number().int().nullable().optional(),
            zLayer: z.union([z.string(), z.number()]).nullable().optional(),
            zOrder: z.number().int().nullable().optional(),
            editorLayer: z.number().int().nullable().optional(),
            editorLayer2: z.number().int().nullable().optional(),
            props: z.record(z.string(), propValue.nullable()).optional(),
          })
          .optional(),
        addGroups: z.array(z.number().int()).optional(),
        removeGroups: z.array(z.number().int()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ uids, selected, area, set, addGroups, removeGroups }) => {
      const patch = { ...set, addGroups, removeGroups } as ObjectPatch;
      const objects = await resolveTarget({ uids, selected, area });
      if (objects.length === 0) return { edited: 0, note: "No matching objects." };
      checkBatchSize(objects.length);

      const data = joinObjects(objects.map(([, saveString]) => patchSaveString(saveString, patch)));
      const result = await bridge.call<{ deleted: number; uids: number[] }>("objects.replace", {
        uids: objects.map(([uid]) => uid),
        data,
        // The user's selection would otherwise be lost along with the old objects
        select: selected ?? false,
      });
      return {
        edited: result.uids.length,
        ...describeUids(result.uids),
        note: "Edited objects have new uids. The edit is two steps in the undo history.",
      };
    },
  );

  tool(
    "gd_transform_objects",
    {
      title: "Move, rotate, scale or flip objects",
      description:
        "Transform existing objects in place with the editor's own tools: one undo step, uids stay valid. " +
        "move shifts by an offset. rotate, scale and flip act on the objects as one group around its centre " +
        "(or around pivot), exactly like selecting them in the editor and using the rotate/scale/flip controls.",
      inputSchema: {
        ...target,
        move: z.object({ dx: z.number(), dy: z.number() }).optional().describe("Offset in level units"),
        rotate: z.number().optional().describe("Degrees clockwise"),
        scale: z
          .union([z.number().positive(), z.object({ x: z.number().positive(), y: z.number().positive() })])
          .optional()
          .describe("Factor relative to the current size"),
        flipX: z.boolean().optional().describe("Mirror left-right"),
        flipY: z.boolean().optional().describe("Mirror top-bottom"),
        pivot: z.object({ x: z.number(), y: z.number() }).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ uids, selected, area, move, rotate, scale, flipX, flipY, pivot }) => {
      const objects = await resolveTarget({ uids, selected, area });
      if (objects.length === 0) return { transformed: 0, note: "No matching objects." };
      return bridge.call("objects.transform", {
        uids: objects.map(([uid]) => uid),
        move: move && [move.dx, move.dy],
        rotate,
        scale: scale === undefined ? undefined : typeof scale === "number" ? [scale, scale] : [scale.x, scale.y],
        flipX,
        flipY,
        pivot: pivot && [pivot.x, pivot.y],
      });
    },
  );

  tool(
    "gd_delete_objects",
    {
      title: "Delete objects",
      description:
        "Delete objects from the open level, as one undo step. Only delete what the user asked to have removed.",
      inputSchema: target,
      annotations: { destructiveHint: true },
    },
    async ({ uids, selected, area }) => {
      const objects = await resolveTarget({ uids, selected, area });
      if (objects.length === 0) return { deleted: 0, note: "No matching objects." };
      return bridge.call("objects.delete", { uids: objects.map(([uid]) => uid) });
    },
  );

  tool(
    "gd_select_objects",
    {
      title: "Select objects in the editor",
      description:
        "Replace the editor's selection, for example to show the user which objects you mean. An empty list deselects everything.",
      inputSchema: { uids: z.array(z.number().int()) },
    },
    async ({ uids }) => bridge.call("selection.set", { uids }),
  );

  for (const [name, method, title] of [
    ["gd_undo", "editor.undo", "Undo"],
    ["gd_redo", "editor.redo", "Redo"],
  ] as const) {
    tool(
      name,
      {
        title,
        description:
          `${title} steps of the editor's history, which also holds the user's own actions. ` +
          "Afterwards uids read earlier may no longer be valid.",
        inputSchema: { steps: z.number().int().min(1).max(50).optional().describe("Default 1") },
        annotations: { destructiveHint: true },
      },
      async ({ steps = 1 }) => {
        let performed = 0;
        let last: { performed: boolean; undoCount: number; redoCount: number } | undefined;
        for (let i = 0; i < steps; i++) {
          last = await bridge.call(method);
          if (!last!.performed) break;
          performed++;
        }
        return { performed, undoCount: last?.undoCount, redoCount: last?.redoCount };
      },
    );
  }

  tool(
    "gd_playtest",
    {
      title: "Start or stop the playtest",
      description: "Start or stop the editor playtest, for the user to watch or play. The level cannot be changed while it runs.",
      inputSchema: { action: z.enum(["start", "stop"]) },
    },
    async ({ action }) => bridge.call(`playtest.${action}`),
  );

  tool(
    "gd_test",
    {
      title: "Test the level automatically",
      description:
        "Play the level automatically with planned button presses and get the result: passed (reached untilX), " +
        "ended (the duration was up and the player alive), died, stopped (the user stopped the playtest) or " +
        "timeout, where and when the run ended, the solid objects next to the player when it died, progress % " +
        "towards untilX and the player's path ('t,x,y;...': seconds since the start and position, every pathEvery " +
        "seconds, skipping points where the player stood still). The game presses the buttons itself. Buttons are " +
        "jump, left and right. Each input is pressed at a player x (x: classic levels, where the player only runs " +
        "right) or at a time (t: seconds of game time since the start, for platformer levels). Each button plays " +
        "its inputs in order and the buttons are independent, so the player can run right while jumping. Classic " +
        "runs end at untilX (default just past the last object); platformer runs end after duration (default 2 " +
        "seconds after the last timed input). Use it to check that a section is beatable, then fix the level or " +
        "the inputs and retry. A cube tap while airborne does nothing, and so does one on the very first frame: " +
        "read the path to see where the player lands, and press after landing or from the edge of a block. Stops " +
        "a running playtest first; objects are not changed.",
      inputSchema: {
        inputs: z
          .array(
            z.object({
              button: z.enum(["jump", "left", "right"]).optional().describe("Default jump"),
              x: z.number().optional().describe("Player x where the button is pressed"),
              t: z.number().min(0).optional().describe("Seconds after the start when the button is pressed"),
              release: z
                .number()
                .optional()
                .describe("Where (with x) or when (with t) it is let go; omit for a tap (one jump)"),
            }),
          )
          .optional()
          .describe("Button presses. Holding works for ship, wave and ufo, for repeated cube jumps and for walking"),
        untilX: z
          .number()
          .optional()
          .describe("The run counts as passed at this x. Default: just past the last object in classic, none in platformer"),
        duration: z.number().min(0.1).max(600).optional().describe("Seconds of game time before the run ends"),
        speed: z.number().min(0.25).max(4).optional().describe("Game speed while testing (default 1)"),
        timeout: z.number().min(1).max(600).optional().describe("Real seconds before giving up (default 120)"),
        pathEvery: z.number().min(0.02).max(2).optional().describe("Seconds between path points (default 0.1)"),
      },
    },
    async (args) => {
      checkInputs(args.inputs);
      return runTest(bridge, args);
    },
  );

  tool(
    "gd_set_camera",
    {
      title: "Move the editor view",
      description:
        "Centre the editor view on a point and/or set the zoom (0.1 to 4, 1 is default). During a playtest the " +
        "view stays on the point instead of following the player, until follow: true or the next playtest. " +
        "hideInvisible switches the editor's own Hide Invisible option (its pause menu): hidden objects, " +
        "triggers and their icons disappear from the playtest view and from screenshots. It is the user's " +
        "setting and stays as set.",
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        zoom: z.number().min(0.1).max(4).optional(),
        follow: z.boolean().optional().describe("During a playtest: follow the player again"),
        hideInvisible: z.boolean().optional(),
      },
    },
    async (args) => bridge.call<Camera>("editor.camera", args),
  );

  tool(
    "gd_search_objects",
    {
      title: "Find object IDs",
      description:
        "Search the catalog of every placeable object by name, e.g. \"spike\", \"cube portal\", \"move trigger\", " +
        `"sawblade". Works without the game running. Categories are the editor's build tabs: ${categoryNames().join(", ")}. ` +
        "Types are the game's gameplay classes, e.g. solid, hazard, slope, decoration, trigger, or a specific " +
        "portal, orb or pad.",
      inputSchema: {
        query: z.string().optional(),
        category: z.string().optional(),
        type: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { total, objects } = searchObjects(args);
      return {
        total,
        objects: objects.map(({ id, name, frame, category, type, width, height }) => ({
          id,
          name,
          frame,
          category,
          type,
          size: [width, height],
        })),
      };
    },
  );

  tool(
    "gd_describe_object",
    {
      title: "Describe an object ID",
      description:
        "What an object ID is, and the named properties objects of its kind accept in props. Use it before " +
        "configuring a trigger. Property meanings follow the labels in the trigger's edit popup in the game.",
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const entry = lookupObject(id);
      if (!entry) throw new Error(`Unknown object ID ${id}. Use gd_search_objects to find valid IDs.`);
      // name -> value type, most specific class first
      const props: Record<string, Record<string, string>> = {};
      for (const { name, type, className } of schemaFor(entry.className).properties()) {
        (props[className] ??= {})[name] = type;
      }
      return {
        ...entry,
        props,
        note:
          "props lists what this kind of object can save, grouped by the class that declares it. The first " +
          "group is specific to this kind of object; the later ones are shared with related objects, and not " +
          "every one has an effect on this ID. To see how the game itself fills them in, set the object up " +
          "in the editor and read it back with gd_get_objects.",
      };
    },
  );

  tool(
    "gd_search_properties",
    {
      title: "Find a property by name or key",
      description:
        "Look up object properties across all kinds of object by part of their name (e.g. \"duration\", " +
        '"targetGroup") or by numeric save-string key.',
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => ({ properties: searchProperties(query) }),
  );

  tool(
    "gd_reference",
    {
      title: "Common IDs and jump physics",
      description:
        "Most used object IDs and measured jump physics for classic play (cube jump height and length per speed, " +
        "pads, orbs, ship). Read it once before building a playable classic section.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => REFERENCE,
  );

  tool(
    "gd_get_level_string",
    {
      title: "Read the raw level string",
      description:
        "The open level exactly as the game saves it: the settings header (keys kA..., colour channels in kS38) and " +
        "every object. Large on big levels; to read objects prefer gd_get_objects.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => bridge.call("level.string"),
  );

  tool(
    "gd_save_level",
    {
      title: "Save the level",
      description:
        "Save the open level like the Save button of the editor's pause menu and write it to disk, so the work " +
        "survives a crash. Stop any playtest first.",
      inputSchema: {},
    },
    async () => bridge.call("level.save"),
  );

  tool(
    "gd_set_song",
    {
      title: "Set the level's song",
      description:
        "Set the open level's song: a custom one by Newgrounds song ID (0 clears it), or one of the game's own " +
        "songs by track number (the Normal tab: 0 is Stereo Madness, then the main levels in order). Pass one of " +
        "the two. Save the level afterwards with gd_save_level. Find custom song IDs with gd_find_songs.",
      inputSchema: {
        songId: z.number().int().min(0).optional(),
        track: z.number().int().min(0).optional().describe("The game's own song"),
      },
    },
    async ({ songId, track }) => {
      if ((songId === undefined) === (track === undefined)) throw new Error("Pass songId or track, not both.");
      return bridge.call("level.song", track === undefined ? { songId } : { track });
    },
  );

  tool(
    "gd_get_level_settings",
    {
      title: "Read the level settings",
      description:
        "The open level's settings, as in the editor's gear button: start speed and mode, game type, options, " +
        "spawn group, background, ground, middleground and font, the song (songId: the custom song, 0 for none; " +
        "track: the game's own song, used while songId is 0) with its offset and fades, and the start colours " +
        "of the colour channels.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => decodeSettings(await bridge.call<RawSettings>("level.settings")),
  );

  const startColor = z.object({
    channel: z
      .union([z.number().int(), z.string()])
      .describe(`1-999, or ${Object.keys(SETTABLE_CHANNELS).join(", ")}`),
    hex: z.string().optional().describe('RRGGBB, e.g. "#287DFF"; or give r, g, b'),
    r: z.number().int().min(0).max(255).optional(),
    g: z.number().int().min(0).max(255).optional(),
    b: z.number().int().min(0).max(255).optional(),
    opacity: z.number().min(0).max(1).optional(),
    blending: z.boolean().optional(),
    playerColor: z.enum(["none", "P1", "P2"]).optional().describe("Follow a player's colour"),
    copyColor: z.number().int().min(0).optional().describe("Copy another channel (0 stops copying)"),
    copyOpacity: z.boolean().optional(),
    hsv: z
      .object({
        h: z.number().min(-180).max(180),
        s: z.number(),
        v: z.number(),
        absoluteSaturation: z.boolean().optional(),
        absoluteBrightness: z.boolean().optional(),
      })
      .optional()
      .describe("HSV shift applied to the copied colour"),
  });

  tool(
    "gd_set_level_settings",
    {
      title: "Change the level settings",
      description:
        "Change the open level's settings, like the editor's gear button. Only the fields given change. " +
        "colors sets the start colour of channels (what Select Color sets), not a colour trigger. Save the level " +
        "afterwards with gd_save_level.",
      inputSchema: {
        speed: z.enum(SPEEDS).optional().describe("Start speed"),
        mode: z.enum(MODES).optional().describe("Start game mode"),
        gameType: z.enum(["classic", "platformer"]).optional(),
        mini: z.boolean().optional(),
        dual: z.boolean().optional(),
        twoPlayer: z.boolean().optional(),
        mirror: z.boolean().optional(),
        flipGravity: z.boolean().optional(),
        rotateGameplay: z.boolean().optional(),
        reverseGameplay: z.boolean().optional(),
        noTimePenalty: z.boolean().optional().describe("Platformer"),
        spawnGroup: z.number().int().min(0).max(9999).optional().describe("Group spawned when the level starts, 0 none"),
        background: z.number().int().min(0).max(59).optional().describe("Background art 1-59"),
        ground: z.number().int().min(0).max(22).optional().describe("Ground art 1-22"),
        middleground: z.number().int().min(0).max(3).optional().describe("Middleground art 1-3, 0 none"),
        font: z.number().int().min(0).max(59).optional().describe("0 is the default font"),
        songOffset: z.number().min(0).optional().describe("Seconds into the song where the level starts"),
        fadeIn: z.boolean().optional(),
        fadeOut: z.boolean().optional(),
        dontReset: z.boolean().optional().describe("Keep the song playing on death"),
        legacy: z
          .object({
            allowMultiRotation: z.boolean().optional(),
            enablePlayerSqueeze: z.boolean().optional(),
            fixGravityBug: z.boolean().optional(),
            fixNegativeScale: z.boolean().optional(),
            fixRobotJump: z.boolean().optional(),
            dynamicLevelHeight: z.boolean().optional(),
            sortGroups: z.boolean().optional(),
            fixRadiusCollision: z.boolean().optional(),
            enable22Changes: z.boolean().optional(),
            allowStaticRotate: z.boolean().optional(),
            reverseSync: z.boolean().optional(),
            decreaseBoostSlide: z.boolean().optional(),
            enableImpulseFix: z.boolean().optional(),
          })
          .optional()
          .describe("Legacy Options: fixes of old game bugs. New levels keep the defaults"),
        colors: z.array(startColor).max(1100).optional(),
      },
    },
    async (args) => decodeSettings(await bridge.call<RawSettings>("level.settings.set", encodeSettings(args))),
  );

  tool(
    "gd_find_songs",
    {
      title: "Find songs",
      description:
        "Search the audio files the game already has by file name (downloaded Newgrounds songs are named " +
        "<song ID>.mp3) and get a Newgrounds search link for finding new ones.",
      inputSchema: {
        query: z.string().max(120).optional().describe("Part of the file name; empty lists everything"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query = "", limit }) => ({
      ...(await bridge.call<Json>("songs.local", { query, limit })),
      ...(query ? { newgroundsSearch: `https://www.newgrounds.com/search/conduct/audio?terms=${encodeURIComponent(query)}` } : {}),
    }),
  );

  server.registerTool(
    "gd_screenshot",
    {
      title: "Screenshot of the game",
      description:
        "A picture of what the game shows right now, e.g. to check how decoration looks. Works while the game " +
        "window is covered or in the background. Move the view first with gd_set_camera.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { path, width, height } = await bridge.call<{ path: string; width: number; height: number }>("screenshot");
        // Keep the picture around 1280 wide: plenty to judge a level, and much cheaper to read
        const png = rgbaToPng(await readFile(path), width, height, Math.max(1, Math.round(width / 1280)));
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
