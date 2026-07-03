# blender-cli

**Drive Blender headless from your AI agent — scaffold projects, build objects, and animate from natural language. JSON in, JSON out.**

[![npm version](https://img.shields.io/npm/v/blender-cli.svg)](https://www.npmjs.com/package/blender-cli)
[![node](https://img.shields.io/node/v/blender-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/blender-cli.svg)](./LICENSE)

> **Disclaimer:** Independent, community project. **Not affiliated with, sponsored by, or endorsed by** the Blender Foundation. "Blender" is a trademark of the Blender Foundation, used here only for identification (nominative) purposes.

> ⚠️ **Early (v0.0.x).** The headless executor, inspector, scaffolder, and preview render work; the natural-language building/animation layer is driven by your agent on top of them. APIs may change.

`blender-cli` is a thin, zero-dependency wrapper that turns your local Blender into a **deterministic boundary an LLM agent can drive**. It runs `bpy` headless (`Blender --background`), captures a single JSON result out of Blender's noisy stdout, and hands it back to your agent. No MCP server, no HTTP daemon, no add-on — just a CLI your agent calls over the shell.

The division of labour: **your agent writes the `bpy`** (translating "make it bounce and spin over 2 seconds" into keyframes); **the CLI runs it deterministically and reports scene state back** so the agent can verify and iterate.

## Requirements

- [Blender](https://www.blender.org/download/) installed locally (macOS default path is auto-detected; override with `BLENDER_BIN` or `--blender <path>`)
- Node.js ≥ 18

## Install

```bash
npm install -g blender-cli      # or: npx blender-cli <command>
```

Or from source (TypeScript; `npm install` builds `dist/` automatically via the `prepare` script):

```bash
git clone https://github.com/renezander030/blender-cli && cd blender-cli && npm install && npm link
```

## Quickstart

```bash
blender-cli doctor                                   # find Blender, confirm headless bpy works, print version
blender-cli new demo --save demo.blend               # scaffold a project: camera + key light + 1080p
blender-cli scene --blend demo.blend                 # inspect scene state as JSON
blender-cli exec 'bpy.ops.mesh.primitive_cube_add()' --blend demo.blend --save demo.blend
blender-cli render --blend demo.blend --out preview.png
```

## Commands

JSON by default; add `-H` for a human-readable view.

| Command | What it does |
|---------|--------------|
| `doctor` | Locate Blender, confirm headless `bpy` runs, report version. **Run this first.** |
| `new <name> [--save f.blend]` | Scaffold a clean project (camera + key light + 1080p). |
| `exec "<bpy>" [--blend f] [--save f]` | Run agent-authored `bpy`; set keys on `result` and they come back as JSON. |
| `run <script.py> [--blend f] [--save f]` | Same, from a `.py` file. |
| `scene [--blend f]` | Dump objects, frame range, materials, and keyframe counts as JSON — the agent's feedback loop. |
| `render [--blend f] --out preview.png [--frame N] [--res 1280x720]` | Render a single preview PNG. |
| `render --anim --out clip.mp4 [--start N] [--end N] [--fps N] [--res WxH]` | Render the frame range as a **video** (`.mp4`/`.mov`/`.mkv`/`.webm`) or, if `--out` has an image extension, a numbered **PNG sequence**. |

**Video encoding:** uses Blender's own FFmpeg when the build has it; otherwise falls back to rendering a PNG sequence and encoding with your system `ffmpeg` (so it works on FFmpeg-less Blender builds). Image-sequence output needs no `ffmpeg`.

**Environment:** `BLENDER_BIN` overrides the binary path (default `/Applications/Blender.app/Contents/MacOS/Blender`).

## How it works

Every command generates a small `bpy` script wrapped so that it can read parameters, mutate a `result` dict, and always emit one sentinel-delimited JSON line. `blender-cli` invokes `Blender --background [file.blend] --python <script>`, extracts that JSON out of Blender's stdout, and returns it. The result: a clean, scriptable, agent-friendly contract over a program that otherwise only speaks GUI or in-process Python.

## License

MIT © Rene Zander
