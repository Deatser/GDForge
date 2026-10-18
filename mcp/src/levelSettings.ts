// Level settings (the editor's gear button) between the names the tools use
// and the numbers the game stores. Start colours come back in the game's own
// "kS38" text: channels joined with "|", each one "key_value_key_value...".

import { parseFields } from "./saveString.js";

// Index = the game's value (Geode's Speed enum and the start mode)
export const SPEEDS = ["normal", "slow", "fast", "faster", "fastest"] as const;
export const MODES = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"] as const;

// Channels the settings window can colour, besides the custom ones 1-999
export const SETTABLE_CHANNELS: Record<string, number> = {
  BG: 1000,
  G: 1001,
  Line: 1002,
  "3DL": 1003,
  Obj: 1004,
  G2: 1009,
  MG: 1013,
  MG2: 1014,
};

const CHANNEL_NAMES = new Map<number, string>([
  ...Object.entries(SETTABLE_CHANNELS).map(([name, id]) => [id, name] as [number, string]),
  [1005, "P1"],
  [1006, "P2"],
  [1007, "LBG"],
  [1010, "Black"],
  [1011, "White"],
  [1012, "Lighter"],
]);

const PLAYER_COLORS = { none: -1, P1: 1, P2: 2 } as const;
type PlayerColor = keyof typeof PLAYER_COLORS;

export interface Hsv {
  h: number;
  s: number;
  v: number;
  absoluteSaturation: boolean;
  absoluteBrightness: boolean;
}

export interface StartColor {
  channel: number;
  name?: string;
  r: number;
  g: number;
  b: number;
  opacity: number;
  blending: boolean;
  playerColor: PlayerColor;
  copyColor?: number;
  copyOpacity?: boolean;
  hsv?: Hsv;
}

export interface ColorInput {
  channel: number | string;
  hex?: string | undefined;
  r?: number | undefined;
  g?: number | undefined;
  b?: number | undefined;
  opacity?: number | undefined;
  blending?: boolean | undefined;
  playerColor?: PlayerColor | undefined;
  copyColor?: number | undefined;
  copyOpacity?: boolean | undefined;
  hsv?: Partial<Hsv> | undefined;
}

export interface SettingsInput {
  speed?: (typeof SPEEDS)[number] | undefined;
  mode?: (typeof MODES)[number] | undefined;
  gameType?: "classic" | "platformer" | undefined;
  colors?: ColorInput[] | undefined;
  [field: string]: unknown;
}

// What the bridge reports for "level.settings"
export interface RawSettings {
  speed: number;
  mode: number;
  platformer: boolean;
  saveString: string;
  [field: string]: unknown;
}

// "h a s a v a absS a absB", as the game writes an HSV value
function parseHsv(text: string): Hsv {
  const [h = "0", s = "1", v = "1", absS = "0", absB = "0"] = text.split("a");
  return { h: Number(h), s: Number(s), v: Number(v), absoluteSaturation: absS === "1", absoluteBrightness: absB === "1" };
}

export function parseColorString(text: string): StartColor[] {
  const colors: StartColor[] = [];
  for (const entry of text.split("|")) {
    if (!entry) continue;
    const parts = entry.split("_");
    const fields = new Map<string, string>();
    for (let i = 0; i + 1 < parts.length; i += 2) fields.set(parts[i]!, parts[i + 1]!);
    const channel = Number(fields.get("6"));
    if (!Number.isInteger(channel)) continue;
    const player = Number(fields.get("4") ?? -1);
    const color: StartColor = {
      channel,
      r: Number(fields.get("1") ?? 255),
      g: Number(fields.get("2") ?? 255),
      b: Number(fields.get("3") ?? 255),
      opacity: Number(fields.get("7") ?? 1),
      blending: fields.get("5") === "1",
      playerColor: player === 1 ? "P1" : player === 2 ? "P2" : "none",
    };
    const name = CHANNEL_NAMES.get(channel);
    if (name) color.name = name;
    const copy = Number(fields.get("9") ?? 0);
    if (copy > 0) {
      color.copyColor = copy;
      color.copyOpacity = fields.get("17") === "1";
      const hsv = fields.get("10");
      if (hsv) color.hsv = parseHsv(hsv);
    }
    colors.push(color);
  }
  return colors;
}

export function decodeSettings(raw: RawSettings): Record<string, unknown> {
  const { speed, mode, platformer, saveString, ...rest } = raw;
  return {
    speed: SPEEDS[speed] ?? speed,
    mode: MODES[mode] ?? mode,
    gameType: platformer ? "platformer" : "classic",
    ...rest,
    colors: parseColorString(parseFields(saveString).get("kS38") ?? ""),
  };
}

function channelId(channel: number | string): number {
  if (typeof channel === "number") {
    if (Number.isInteger(channel) && channel >= 1 && channel <= 999) return channel;
    if (Object.values(SETTABLE_CHANNELS).includes(channel)) return channel;
  } else {
    const id = Object.entries(SETTABLE_CHANNELS).find(([name]) => name.toLowerCase() === channel.toLowerCase())?.[1];
    if (id !== undefined) return id;
  }
  throw new Error(
    `Colour channel ${JSON.stringify(channel)} cannot be set: use 1-999 or one of ${Object.keys(SETTABLE_CHANNELS).join(", ")}.`,
  );
}

function encodeColor(color: ColorInput): Record<string, unknown> {
  const { channel, hex, playerColor, ...rest } = color;
  const out: Record<string, unknown> = { ...rest, channel: channelId(channel) };
  if (hex !== undefined) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!match) throw new Error(`"${hex}" is not a colour: use RRGGBB hex, e.g. "#287DFF".`);
    [out.r, out.g, out.b] = match.slice(1).map((part) => parseInt(part, 16));
  }
  if (playerColor !== undefined) out.playerColor = PLAYER_COLORS[playerColor];
  return out;
}

// The bridge's "level.settings.set" parameters for the fields given
export function encodeSettings(input: SettingsInput): Record<string, unknown> {
  const { speed, mode, gameType, colors, ...rest } = input;
  const out: Record<string, unknown> = { ...rest };
  if (speed !== undefined) out.speed = SPEEDS.indexOf(speed);
  if (mode !== undefined) out.mode = MODES.indexOf(mode);
  if (gameType !== undefined) out.platformer = gameType === "platformer";
  if (colors !== undefined) out.colors = colors.map(encodeColor);
  return out;
}
