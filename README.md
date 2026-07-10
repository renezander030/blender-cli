# blender-cli

**Drive Blender headless from your AI agent — scaffold projects, build objects, and animate from natural language. JSON in, JSON out.**

[![npm version](https://img.shields.io/npm/v/blender-cli.svg)](https://www.npmjs.com/package/blender-cli)
[![node](https://img.shields.io/node/v/blender-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/blender-cli.svg)](./LICENSE)

> **Disclaimer:** Independent, community project. **Not affiliated with, sponsored by, or endorsed by** the Blender Foundation. "Blender" is a trademark of the Blender Foundation, used here only for identification (nominative) purposes.

> ⚠️ **Early (v0.0.x).** The headless executor, inspector, scaffolder, and preview render work; the natural-language building/animation layer is driven by your agent on top of them. APIs may change.

`blender-cli` is a thin, zero-dependency wrapper that turns your local Blender into a **deterministic boundary an LLM agent can drive**. It runs `bpy` headless (`Blender --background`), captures a single JSON result out of Blender's noisy stdout, and hands it back to your agent. No MCP server, no HTTP daemon, no add-on — just a CLI your agent calls over the shell.

The division of labour: **your agent writes the `bpy`** (translating "make it bounce and spin over 2 seconds" into keyframes); **the CLI runs it deterministically and reports scene state back** so the agent can verify and iterate.

## Why a CLI, not an MCP server?

**You don't need an MCP server (or a Blender add-on) to give an agent Blender — a CLI is lighter.**

- **No server, no daemon, no socket** to start, supervise, or reconnect — nothing left running. Each call spawns `Blender --background`, does its work, and exits.
- **No add-on** to install into Blender or enable per version.
- **Works with any agent that can run a shell command** — Claude Code, Codex, a plain script, cron — not only MCP clients.
- **Zero runtime dependencies** — just `Blender` and Node ≥ 18.

If you already speak MCP, fine — but for driving Blender headless, a shell command is the smaller, more portable surface.

## Requirements

- [Blender](https://www.blender.org/download/) installed locally (auto-detected on macOS/Windows/Linux at well-known install paths or via `PATH`; override with `BLENDER_BIN` or `--blender <path>` — see "Locating Blender" below)
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
| `doctor` | Locate Blender, confirm headless `bpy` runs, report version + every candidate path probed. **Run this first.** |
| `new <name> [--save f.blend]` | Scaffold a clean project (camera + key light + 1080p). |
| `exec "<bpy>" [--blend f] [--save f] [--safe\|--unsafe]` | Run agent-authored `bpy`; set keys on `result` and they come back as JSON. |
| `run <script.py> [--blend f] [--save f] [--safe\|--unsafe]` | Same, from a `.py` file. |
| `scene [--blend f]` | Dump objects, frame range, materials, and keyframe counts as JSON — the agent's feedback loop. |
| `verify [--blend f]` | Geometry audit: per-object world bbox/dimensions, AABB overlaps, transform sanity (non-uniform/negative/huge scale), below-ground/floating checks, camera-frustum coverage. |
| `import <path\|polyhaven:id> [--blend f] [--save f] [--type texture\|model\|hdri] [--res 1k\|2k\|4k]` | Import `.obj`/`.glb`/`.gltf`/`.fbx`/`.stl`/`.ply`, or fetch + import a Poly Haven asset. |
| `generate "<prompt>" --out asset.glb [--import] [--backend meshy]` | Text-to-3D via a pluggable backend (default Meshy; needs `MESHY_API_KEY`). |
| `add cube\|sphere\|plane\|cylinder\|cone\|torus [--size N] [--at x,y,z] [--name NAME]` | Add a primitive mesh. |
| `add camera [--at x,y,z] [--look-at x,y,z]` | Add a camera, optionally aimed at a point. |
| `add light [--type sun\|point\|area] [--energy N] [--at x,y,z]` | Add a light. |
| `add --json '[{"what":"cube","size":2}, ...]'` | Batch of `add` ops, all executed in one Blender launch. |
| `keyframe <object> --prop location\|rotation\|scale --frame N --value x,y,z` | Insert a keyframe on an object property. |
| `render [--blend f] --out preview.png [--frame N] [--res 1280x720]` | Render a single preview PNG. |
| `render --anim --out clip.mp4 [--start N] [--end N] [--fps N] [--res WxH]` | Render the frame range as a **video** (`.mp4`/`.mov`/`.mkv`/`.webm`) or, if `--out` has an image extension, a numbered **PNG sequence**. |

**Video encoding:** uses Blender's own FFmpeg when the build has it; otherwise falls back to rendering a PNG sequence and encoding with your system `ffmpeg` (so it works on FFmpeg-less Blender builds). Image-sequence output needs no `ffmpeg`.

### `verify` — geometry audit

The agent's "did the build actually work" loop, one level up from `scene`. Returns `{ok, objects, issues, summary}`: per-object world-space bounding box + dimensions, then scene-level checks — pairwise AABB overlaps among mesh objects, non-uniform/negative/huge (likely-unapplied) scale, objects below `z=0`, objects floating far from the rest of the scene, whether a camera exists, and a best-effort camera-frustum coverage check per mesh (`in_camera_view: full|partial|none`).

### `import` — local files + Poly Haven

Local `.obj`/`.glb`/`.gltf`/`.fbx`/`.stl`/`.ply` import via the correct Blender 4.x/5.x operator, probed at runtime (`hasattr(bpy.ops.wm, "obj_import")` etc.) so it adapts across Blender versions instead of hard-coding one API generation.

`import polyhaven:<asset-id> [--type texture|model|hdri] [--res 1k|2k|4k]` fetches from the free, keyless [Poly Haven](https://polyhaven.com) API into `~/.cache/blender-cli/polyhaven/` and imports it: a **model** downloads the glTF package (mesh + textures) and imports it like a local file; an **hdri** downloads the `.hdr`/`.exr` and sets it as the world environment texture; a **texture** downloads the map set (diffuse/normal/roughness/...) at the given resolution and builds a Principled BSDF material from them. `--type` overrides the asset's declared type if you know better; `--res` defaults to `1k`.

### `generate` — text-to-3D

`generate "<prompt>" --out asset.glb [--import] [--backend meshy]` submits a text-to-3D task to a pluggable backend (default: [Meshy](https://www.meshy.ai), needs `MESHY_API_KEY`), polls until done, and downloads the resulting `.glb`. `--import` chains straight into the same import logic as `import <path>`. No key set → clean `{ok:false, error:"MESHY_API_KEY not set"}` with no network call. Backends live in a small registry (`meshy: ...`) so a second provider (Rodin, Hunyuan/ai3d, ...) is a new map entry, not a restructure.

### `add` / `keyframe` — parametric verbs

Stable high-level verbs that survive bpy API drift across Blender versions (primitive-add operators and their args occasionally change between releases; these don't). `add --json '[...]'` runs a whole batch of ops in one Blender launch — useful for building a scene in a single round trip instead of one process spawn per object. `keyframe` inserts a single keyframe on `location`/`rotation`/`scale` at a given frame; call it repeatedly to build up an animation.

### `exec`/`run --safe` — opt-in AST sandbox

By default `exec`/`run` execute agent-supplied `bpy` with no restriction, unchanged. Pass `--safe` (or set `BLENDER_CLI_SAFE=1` to make it the default, then `--unsafe` to opt back out for one call) to run the code through a Python `ast`-based validation pass **inside** the generated bpy script, before anything is executed: it rejects imports of `os`/`subprocess`/`socket`/`shutil`/`sys`/`ctypes`/`urllib`/`http`, `open()`/`Path(...).open()` in write/append mode, `eval`/`exec`/`__import__`, `getattr()`-based module escapes, and attribute access that looks like a filesystem/process escape (`.system`, `.popen`, `.rmtree`, `.write_text`, ...) — while everyday bpy/str methods like `.remove`/`.unlink`/`.replace` (`bpy.data.objects.remove` etc.) stay allowed. A rejected call returns `{ok:false, error:"sandbox: ...", violations:[...]}` and never executes the code. This is a best-effort static gate, not a real sandbox — Blender's Python still has full process privileges once code runs; `--safe` narrows what an agent can accidentally or maliciously do, it doesn't guarantee isolation.

**Environment:** `BLENDER_BIN` overrides the binary path (see precedence below). `MESHY_API_KEY` for `generate --backend meshy`. `BLENDER_CLI_SAFE=1` makes `--safe` the default for `exec`/`run`.

**Locating Blender (cross-platform):** precedence is `--blender <path>` flag → `BLENDER_BIN` env var → platform-specific well-known locations → `which`/`where blender` on `PATH` → bare `blender`/`blender.exe` (resolved by the OS at spawn time). Well-known locations: macOS `/Applications/Blender.app/...` (+ `~/Applications`); Windows `C:\Program Files\Blender Foundation\Blender <ver>\blender.exe` (globbed, highest version wins); Linux `/usr/bin/blender`, `/snap/bin/blender`, common Flatpak export paths. `doctor` reports every candidate probed and which one was selected.

## How it works

Every command generates a small `bpy` script wrapped so that it can read parameters, mutate a `result` dict, and always emit one sentinel-delimited JSON line. `blender-cli` invokes `Blender --background [file.blend] --python <script>`, extracts that JSON out of Blender's stdout, and returns it. The result: a clean, scriptable, agent-friendly contract over a program that otherwise only speaks GUI or in-process Python.

## License

MIT © Rene Zander
