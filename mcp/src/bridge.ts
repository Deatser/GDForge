// Client for the HTTP bridge the GD Forge mod opens inside Geometry Dash.

export const DEFAULT_PORT = 47821;

// The mod itself gives up on a call after 30 seconds
const TIMEOUT_MS = 35_000;

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

type Reply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export class Bridge {
  private readonly url: string;

  constructor(port: number = DEFAULT_PORT) {
    this.url = `http://127.0.0.1:${port}/rpc`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        // The mod only accepts requests carrying this header
        headers: { "Content-Type": "application/json", "X-GDForge": "1" },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new BridgeError("timeout", "Geometry Dash did not answer in time. Check that the game is not frozen.");
      }
      throw new BridgeError(
        "not_running",
        "Cannot reach Geometry Dash. Make sure the game is running with Geode and the GD Forge mod " +
          "installed and enabled, and that the mod's port setting matches GDFORGE_PORT.",
      );
    }

    let reply: Reply<T>;
    try {
      reply = (await response.json()) as Reply<T>;
    } catch {
      throw new BridgeError(
        "bad_reply",
        `Unexpected reply from port ${new URL(this.url).port} (HTTP ${response.status}). ` +
          "Another program may be using the port; change it in the mod settings and GDFORGE_PORT.",
      );
    }
    if (!reply.ok) throw new BridgeError(reply.error.code, reply.error.message);
    return reply.result;
  }
}

// Shapes of the bridge replies the tools rely on

export interface EditorInfo {
  level: { name: string; objectCount: number; lastObjectX: number };
  camera: Camera;
  editorLayer: number;
  selectedCount: number;
  undoCount: number;
  redoCount: number;
  playtesting: boolean;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  // Size of the visible area in level units
  viewWidth: number;
  viewHeight: number;
}

export interface Status {
  mod: string;
  geode: string;
  gd: string;
  platform: string;
  editor: EditorInfo | null;
}

// [uid, save string]
export type RawObject = [number, string];
