<p align="center">
  <img src="https://raw.githubusercontent.com/renezander030/blender-cli/master/assets/logo.svg" alt="blender-cli: Blender, driven by your agent. JSON in, bpy runs headless, JSON out." width="720">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/blender-cli"><img src="https://img.shields.io/npm/v/blender-cli.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/blender-cli.svg" alt="node"></a>
  <img src="https://img.shields.io/badge/Blender-3.0%2B%20(tested%20on%204.3)-0d9488" alt="Blender 3.0+, tested on 4.3">
  <img src="https://img.shields.io/badge/dependencies-zero-0d9488" alt="zero dependencies">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/blender-cli.svg" alt="license"></a>
</p>

**Your agent writes the `bpy`. This runs it.** `blender-cli` is a zero-dependency, single-file CLI that turns a local Blender install into a deterministic boundary an LLM agent can drive: it runs agent-authored Python headless (`blender --background`), captures one clean JSON result out of Blender's noisy stdout, and hands it back. Scaffold a scene, build objects, keyframe motion, render the proof, export the asset. No MCP server, no HTTP daemon, no add-on, no API key.

```bash
npm install -g blender-cli && blender-cli doctor
```

## New in v0.2.0

- **Poly Haven asset import**: `import polyhaven:<id>` fetches any of Poly Haven's thousands of free assets and does the right thing per kind: models land as objects (with all texture sidecars), HDRIs become the world environment, textures become a wired Principled BSDF material. Downloads cache in `~/.cache/blender-cli`, so repeat imports cost zero bytes.
- **Text-to-3D**: `generate "a weathered wooden barrel" --import` submits to Meshy (bring your `MESHY_API_KEY`), polls to completion, downloads the GLB and drops it straight into your scene.
- **`--safe` mode**: an AST gate for `exec`/`run` that *refuses* agent code touching banned modules (`os`, `subprocess`, `socket`, ...), `eval`/`exec`, write-mode `open()`, or system/filesystem escape attributes, then runs clean code in a namespace containing only `bpy`, `PARAMS` and `result`. `BLENDER_CLI_SAFE=1` makes it the default; `--unsafe` overrides. Best-effort static gate, not a jail; `--check` remains the advisory scanner.

## New in v0.1.0

- **`import` / `export`**: glTF/GLB, OBJ, FBX, STL, PLY, USD in and out. ML output in, engine-ready asset out.
- **Animation rendering**: `render --animation` turns the frame range into an MP4 (Blender's own ffmpeg) or a PNG sequence. The agent can finally *see* the motion it keyframed.
- **Render control**: `--engine cycles|eevee|workbench`, `--device cpu|cuda|optix|metal|hip|oneapi`, `--samples N`, `--denoise on|off`. Built for GPU-less servers and CI, not just desktops.
- **Verifiable renders**: every render returns engine, resolution, samples, frame(s), duration and file size as JSON. No second round-trip to check what you produced.
- **Guardrails**: `exec --check` compiles agent code and flags risky calls (shell, network, deletes) *without executing anything*; `--timeout <sec>` kills a hung Blender instead of hanging your agent; agent `print()` output comes back as `logs`.
- **`doctor` v2**: cross-platform binary discovery (macOS, Linux, snap, flatpak, Windows), a version-support verdict, and a capability report: importers, video support, render engines, GPU devices.

## Why a CLI and not an MCP server

The pains are well documented across the agent-Blender ecosystem, in public issue trackers:

| Recurring pain elsewhere | Here |
|---|---|
| GUI-oriented bridges break in `--background`: timers never fire, tools time out, CI needs X11 ([blender-mcp#252](https://github.com/ahujasid/blender-mcp/pull/252), [#279](https://github.com/ahujasid/blender-mcp/issues/279)) | Headless is the only mode. Every command is a fresh `blender --background` run. |
| Python dependency chains and version conflicts block install ([blender-mcp#226](https://github.com/ahujasid/blender-mcp/issues/226), [TRELLIS#3](https://github.com/microsoft/TRELLIS/issues/3)) | One file, zero npm dependencies, nothing to compile. |
| Locked to one LLM client; users ask for Ollama, Gemini, local models ([blender-mcp#14](https://github.com/ahujasid/blender-mcp/issues/14)) | No model, no protocol, no vendor. Any agent that can shell out can drive it. |

The division of labour: **your agent writes the `bpy`** (translating "make it bounce and spin over 2 seconds" into keyframes); **the CLI runs it deterministically and reports scene state back** so the agent can verify and iterate.

## Requirements

- [Blender](https://www.blender.org/download/) 3.0+ installed locally (auto-detected on macOS, Linux, snap, flatpak and Windows; override with `BLENDER_BIN` or `--blender <path>`)
- Node.js 18+

## Quickstart: the agent loop

```bash
blender-cli doctor                       # find Blender, verify headless bpy, list capabilities
blender-cli new demo --save demo.blend   # scaffold: camera + key light + 1080p
blender-cli exec 'bpy.ops.mesh.primitive_cube_add()' --blend demo.blend --save demo.blend
blender-cli scene --blend demo.blend     # inspect state as JSON: the feedback loop
blender-cli render --blend demo.blend --out preview.png
```

Then close the loop the new way:

```bash
# bring an asset in, animate it, prove the motion, ship the result
blender-cli import model.glb --blend demo.blend --save demo.blend
blender-cli exec 'cube = bpy.data.objects["Cube"]
for f, z in [(1, 0), (12, 2.5), (24, 0)]:
    cube.location.z = z; cube.keyframe_insert(data_path="location", frame=f)' --blend demo.blend --save demo.blend
blender-cli render --animation --blend demo.blend --out bounce.mp4 --frames 1..24 --fps 24
blender-cli export demo.glb --blend demo.blend
```

Safety-check agent code before it touches anything:

```bash
blender-cli exec 'import os; os.system("rm -rf /")' --check
# {"ok":true,"result":{"compiles":true,"warnings":[{"call":"os.system","risk":"shell command"}],"checked_only":true}}
```

## Commands

One JSON object on stdout per invocation; exit code 1 exactly when `ok` is false. Add `-H` for a pretty-printed view. `--timeout <sec>` and `--blender <path>` work everywhere.

| Command | What it does |
|---------|--------------|
| `doctor` | Locate Blender, verify headless `bpy`, report version support, import/export formats, video support, engines, GPU devices. **Run this first.** |
| `new <name> [--save f.blend]` | Scaffold a clean project (camera + key light + 1080p). |
| `exec "<bpy>" [--blend f] [--save f] [--check] [--safe]` | Run agent-authored `bpy`; set keys on `result` and they come back as JSON. `--check` compiles + flags risky calls without executing; `--safe` refuses code that trips the AST gate. |
| `run <script.py> [--blend f] [--save f] [--check]` | Same, from a `.py` file. |
| `scene [--blend f]` | Dump objects, frame range, engine, resolution, materials and keyframe counts as JSON. |
| `import <file> [--blend f] [--save f]` | Pull an asset in: `glb gltf obj fbx stl ply usd usda usdc usdz abc dae`; a local `.hdr`/`.exr` becomes the world environment. Reports what arrived (objects, types, vert count). |
| `import polyhaven:<id> [--type hdri\|texture\|model] [--res 1k\|2k\|4k]` | Fetch + import a [Poly Haven](https://polyhaven.com) asset: model → objects, HDRI → world environment, texture → wired PBR material. Cached in `~/.cache/blender-cli`. |
| `generate "<prompt>" [--out f.glb] [--import] [--wait sec]` | Text-to-3D via [Meshy](https://www.meshy.ai) (`MESHY_API_KEY` required): submit, poll, download the GLB, optionally chain into the scene. |
| `export <out> [--blend f] [--selected]` | Hand the scene on: `glb gltf obj fbx stl ply usd`. Format from the extension. |
| `render [--blend f] --out p.png [--frame N] [--res WxH] [--engine E] [--device D] [--samples N] [--denoise on\|off]` | Single-frame preview with a verifiable result: engine, resolution, samples, duration, bytes. |
| `render --animation --out clip.mp4 [--frames 1..48] [--fps 24] [...]` | Render the frame range: MP4/MOV/WEBM via Blender's ffmpeg, or a PNG sequence for any other `--out`. |
| `version` | Print name and version. |

## How it works

Each command writes a tiny Python wrapper to a temp file and runs `blender --background [file.blend] --python wrapper.py`. The wrapper:

1. parses `PARAMS` (your flags, JSON-encoded, no shell-quoting hazards),
2. executes the `bpy` body with `stdout` captured, so agent `print()` calls come back as `logs` instead of vanishing,
3. emits one sentinel-delimited, base64-armored JSON line with `ok`, `result`, `ms` and optional `logs`, which the CLI extracts from Blender's noisy output (agent output can never collide with the delimiters),
4. exits nonzero on failure, with `error` and the full Python `trace` in the JSON.

State lives in `.blend` files you name; the CLI holds none. Runs compose like any Unix pipeline.

**Environment:** `BLENDER_BIN` overrides the binary path. Auto-detection order: `--blender` flag, `BLENDER_BIN`, platform install paths (macOS app bundle; `/usr/bin`, snap, flatpak on Linux; `Program Files` on Windows), then `PATH`.

## License

MIT. See [LICENSE](./LICENSE).

> **Disclaimer:** Independent, community project. **Not affiliated with, sponsored by, or endorsed by** the Blender Foundation. "Blender" is a trademark of the Blender Foundation, used here only for identification (nominative) purposes. The blender-cli logo is an original mark and deliberately distinct from the Blender logo, which is a registered property of the Blender Foundation.
