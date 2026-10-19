# GD Forge

Lets an AI assistant build inside the real Geometry Dash level editor. You describe what you want in your AI client; objects appear in the editor you already know, as if you had placed them yourself, and every change lands in the editor's own undo history.

It works with any assistant that supports the [Model Context Protocol](https://modelcontextprotocol.io) (Claude Code, Claude Desktop, Cursor, and others).

## How it works

```
AI client  ──MCP (stdio)──▶  gdforge-mcp  ──HTTP on 127.0.0.1──▶  GD Forge mod  ──▶  level editor
              mcp/                                                   mod/ (Geode)
```

- **`mod/`** is a [Geode](https://geode-sdk.org) mod that runs inside the game. It exposes the open editor on a local port and performs each request with the same functions the editor's own buttons call (paste, delete, transform, undo), so the game stays in a state it could have reached by hand.
- **`mcp/`** is the MCP server your AI client launches. It turns the game's raw object format into named fields, knows every object ID and every trigger property, and offers the tools below.

There is no separate editor and no in-game chat. The AI works on the level; you watch it in the game.

## Requirements

- Geometry Dash 2.2081 on Windows or macOS (Steam)
- [Geode](https://geode-sdk.org/install) 5.11 or newer
- [Node.js](https://nodejs.org) 20.10 or newer

## Install

1. **Install Geode** with its installer and start the game once.
2. **Install the mod.** Download `gdforge.editor.geode` from this repository's releases and put it in Geode's `mods` folder (in the game: Geode button → settings → *Open Mods Folder*). Restart the game.
3. **Build the MCP server** (until it is published to npm):
   ```bash
   cd mcp
   npm install
   npm run build
   ```
4. **Add it to your AI client**, pointing at the built `mcp/dist/index.js`.

   Claude Code:
   ```bash
   claude mcp add gdforge -- node /absolute/path/to/GDForge/mcp/dist/index.js
   ```
   Clients configured with JSON (Claude Desktop, Cursor, ...):
   ```json
   {
     "mcpServers": {
       "gdforge": {
         "command": "node",
         "args": ["/absolute/path/to/GDForge/mcp/dist/index.js"]
       }
     }
   }
   ```

The bridge listens on port 47821. To change it, set the port in the mod's settings in the game and set the `GDFORGE_PORT` environment variable for the MCP server to the same value.

## Using it

Open a level in the editor, then ask your assistant, for example:

- "Add a staircase of five blocks starting at the third column."
- "Put the objects I have selected into a new group and add a move trigger that lifts them two blocks over one second."
- "Replace every spike between x = 900 and x = 1500 with the small spike."

The assistant can also open the editor itself, on one of your levels, a new level, or a temporary scratch level that is never saved.

Changes are not saved until you save in the editor, exactly as with your own edits.

## Tools

| Tool | What it does |
| --- | --- |
| `gd_status` | Connection to the game and whether a level is open |
| `gd_list_levels`, `gd_open_level` | List your created levels; open one, create one, or open a scratch level |
| `gd_get_level_info` | Overview: size, bounds, most used objects, groups and colour channels in use, a free group ID |
| `gd_get_objects` | Read objects, filtered by area, object ID, group, layer or the current selection |
| `gd_place_objects` | Place objects (one undo step per call) |
| `gd_fill_area` | Fill or outline a rectangle with one object |
| `gd_line` | Place one object along a line, by spacing or by count |
| `gd_copy` | Duplicate objects with an offset, repeated several times if asked |
| `gd_map` | ASCII map of an area, one character per grid cell |
| `gd_edit_objects` | Change any property of existing objects, including trigger settings and groups |
| `gd_transform_objects` | Move, rotate, scale, flip with the editor's own routines (one undo step, IDs stay valid) |
| `gd_delete_objects` | Delete objects (one undo step) |
| | Editing, transforming, copying and deleting take uids, the current selection or an area |
| `gd_select_objects` | Set the editor's selection |
| `gd_undo`, `gd_redo` | Step through the editor's history |
| `gd_set_camera` | Move and zoom the editor view, also during a playtest; switch Hide Invisible |
| `gd_playtest`, `gd_test` | Start or stop the playtest; play the level automatically with planned jumps, and in platformer with left and right, and report where the player died |
| `gd_screenshot` | Picture of what the game shows |
| `gd_save_level` | Save the open level and write it to disk |
| `gd_get_level_settings`, `gd_set_level_settings` | Read and change the level settings: start speed and mode, game type, options, art, font, song with its offset and fades, start colours |
| `gd_get_level_string` | The open level as the game saves it, settings included |
| `gd_set_song`, `gd_find_songs` | Set the level's song (Newgrounds ID or one of the game's own); find songs the game already has |
| `gd_reference` | Common object IDs and measured jump physics for classic play |
| `gd_search_objects` | Find object IDs by name, category or type; works without the game |
| `gd_describe_object` | What an object ID is and which properties it accepts |
| `gd_search_properties` | Look up a property by name or save-string key |

## Good to know

- **Coordinates** are level units: 30 per grid cell, the top of the ground at y = 0, positions at object centres. A block on the ground in the first column is at (15, 15).
- **Undo.** Placing, deleting and transforming are one undo step each. Editing properties is two (the game rebuilds the object), and edited objects get new IDs.
- **Background play on macOS.** Geometry Dash normally freezes when another app has focus. While a level is open in the editor the mod keeps the game running so you can watch it change with your AI client in front. Outside the editor the game stays paused as usual.
- **Local only.** The bridge binds to 127.0.0.1 and rejects requests from web pages. It can be turned off in the mod's settings.
- **The view follows the work.** When objects are placed off screen the editor view moves to them; pass `follow: false` to keep it still.

## Development

Build the mod (needs the [Geode CLI and SDK](https://docs.geode-sdk.org/getting-started/)):

```bash
cd mod
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build
```

The build installs the mod into the game selected in your Geode CLI profile. `.github/workflows/build.yml` builds it for Windows and macOS on every push.

Test the MCP server:

```bash
cd mcp
npm test          # unit tests, no game needed
npm run e2e       # against a running game left in its menus; uses a scratch level only
```

### After a game update

Two data files describe the game and are generated, not written by hand:

- `mcp/src/data/properties.json`: which save-string key means what, per object class. Generated from the [Geode bindings](https://github.com/geode-sdk/bindings):
  ```bash
  node mcp/scripts/gen-properties.mjs path/to/bindings/bindings/<gd version>/GeometryDash.bro
  ```
- `mcp/src/data/objects.json`: every object ID with its sprite, build tab, gameplay type, class and size. Dumped from the running game by the mod; see the header of `mcp/scripts/gen-catalog.mjs`.

### Layout of the mod

| File | Role |
| --- | --- |
| `src/net/HttpServer.cpp` | Localhost HTTP transport and request filtering |
| `src/Bridge.cpp` | JSON-RPC dispatch |
| `src/GameThread.cpp` | Runs requests on the game's own thread, also while the game is paused in the background |
| `src/rpc/*.cpp` | The methods: objects, editor, levels, catalog, playtest, screenshot |

## Status

Version 0.3 covers objects (reading, placing, editing, transforming, copying, deleting, selection, undo), level settings, automated playtests of classic and platformer sections, screenshots, saving and the level's song.

The macOS build is tested in the game on Apple Silicon, the Windows build on Windows 11 with GD 2.2081.

## Credits

GD Forge is a personal fork of [GDBuilder AI](https://github.com/TalhaMudo/GDBuilderAI) by TalhaMudo. Built on the [Geode SDK](https://github.com/geode-sdk/geode). The property table is derived from the community's reverse-engineering work in [geode-sdk/bindings](https://github.com/geode-sdk/bindings). The automated playtest, ASCII map and jump physics come from [GD AI Bridge](https://github.com/RibomX/GD-AI-bridge), saving and the song from [AI Level Connector](https://github.com/oliverja0612-prog/Ai-connector); see [THIRD_PARTY.md](THIRD_PARTY.md).
