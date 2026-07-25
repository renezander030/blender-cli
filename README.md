<p align="center">
  <img src="https://raw.githubusercontent.com/renezander030/blender-cli/master/assets/logo.svg" alt="blender-cli: Blender, driven by your agent. JSON in, bpy runs headless, JSON out." width="720">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/blender-cli"><img src="https://img.shields.io/npm/v/blender-cli.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/blender-cli.svg" alt="node"></a>
  <img src="https://img.shields.io/badge/Blender-3.0%2B%20(tested%20on%204.3%20%26%205.2)-0d9488" alt="Blender 3.0+, tested on 4.3 and 5.2">
  <img src="https://img.shields.io/badge/dependencies-zero-0d9488" alt="zero dependencies">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/blender-cli.svg" alt="license"></a>
</p>

**Your agent writes the `bpy`. This runs it.** `blender-cli` is a zero-dependency, single-file CLI that turns a local Blender install into a deterministic boundary an LLM agent can drive: it runs agent-authored Python headless (`blender --background`), captures one clean JSON result out of Blender's noisy stdout, and hands it back. Scaffold a scene, build objects, keyframe motion, render the proof, export the asset. No MCP server, no HTTP daemon, no add-on, no API key.

```bash
npm install -g blender-cli && blender-cli doctor
```

## New in v0.3.0

Blender 5.x, and a theme of **trust the output**: earlier releases built the pipeline, this one makes what comes out of it checkable.

- **Blender 5.x support** — and `render --engine eevee` was genuinely broken on it before now. EEVEE shipped as `BLENDER_EEVEE`, became `BLENDER_EEVEE_NEXT` in 4.2, then took its old name back in 5.0, so the hardcoded identifier died with `enum "BLENDER_EEVEE_NEXT" not found` on every 5.x render — while `doctor` cheerfully called 5.x "supported". The engine is now resolved from the enum the running build advertises, and `doctor` says `tested` only for versions the suite actually ran against (4.3.2 and 5.2.0), `untested` otherwise. It will not claim support it has not earned.
- **Export fidelity census**: `export` reads the file back and tells you what survived — meshes, verts, materials, UV layers, colour attributes, shape keys, scene-vs-file. Exporters drop vertex-colour layers and shape-key ranges silently ([glTF-Blender-IO#2731](https://github.com/KhronosGroup/glTF-Blender-IO/issues/2731), [#2728](https://github.com/KhronosGroup/glTF-Blender-IO/issues/2728)) and a corrupt asset then travels down the pipeline looking like a success. Compared only against what each format can carry, so STL is never accused of losing materials it cannot hold. `--strict` makes degradation a non-zero exit.
- **`verify`**: lint a scene before spending a render on it — missing camera, empty meshes, NaN and degenerate transforms, unapplied non-uniform scale, off-camera objects, real overlaps. Two objects merely touching are *not* an overlap: interpenetration must exceed `--tolerance` on all three axes, and the depth is reported so you can judge.
- **Image-to-3D**: `generate --image ref.png --import` builds a model from a reference photo, alongside the existing text-to-3D.
- **Batch**: `render --batch "shots/*.blend" --out renders/`, `export <dir> --batch "*.blend" --format glb`, `import --batch "assets/*.glb"`. Every file runs even if one fails, results are per file, exit code covers the whole run.
- **Cycles no longer dies on servers without OpenImageDenoise.** Denoising is on by Blender's default and a build without OIDN aborts the render with "Failed to denoise", never hinting the setting was optional — which is how most distro packages ship. It now stands down automatically and says so; an explicit `--denoise on` fails with a reason.
- **No inherited stdin**: Blender no longer holds the agent's stdin pipe, the classic cause of a headless child hanging forever on Windows. Discovery there also covers Steam, Store, scoop and Chocolatey layouts.
- **`test/smoke.mjs`**: 35 end-to-end checks against a real Blender. This is what backs the tested-version badge.

## New in v0.2.0

- **Poly Haven asset import**: `import polyhaven:<id>` fetches any of Poly Haven's thousands of free assets and does the right thing per kind: models land as objects (with all texture sidecars), HDRIs become the world environment, textures become a wired Principled BSDF material. Downloads cache in `~/.cache/blender-cli`, so repeat imports cost zero bytes.
- **Text-to-3D**: `generate "a weathered wooden barrel" --import` submits to Meshy (bring your `MESHY_API_KEY`), polls to completion, downloads the GLB and drops it straight into your scene.
- **`--safe` mode**: an AST gate for `exec`/`run` that *refuses* agent code touching banned modules (`os`, `subprocess`, `socket`, ...), `eval`/`exec`, write-mode `open()`, or system/filesystem escape attributes, then runs clean code in a namespace containing only `bpy`, `PARAMS` and `result`. `BLENDER_CLI_SAFE=1` makes it the default; `--unsafe` overrides. Best-effort static gate, not a jail; `--check` remains the advisory scanner.

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
| `verify [--blend f] [--tolerance 0.001] [--fail-on error\|warn\|none]` | Lint the scene: missing camera, empty meshes, NaN/degenerate transforms, unapplied non-uniform scale, off-camera objects, real overlaps. Findings are tiered error/warn/info; touching is not overlapping. |
| `import <file> [--blend f] [--save f]` | Pull an asset in: `glb gltf obj fbx stl ply usd usda usdc usdz abc dae`; a local `.hdr`/`.exr` becomes the world environment. Reports what arrived (objects, types, vert count). |
| `import polyhaven:<id> [--type hdri\|texture\|model] [--res 1k\|2k\|4k]` | Fetch + import a [Poly Haven](https://polyhaven.com) asset: model → objects, HDRI → world environment, texture → wired PBR material. Cached in `~/.cache/blender-cli`. |
| `import --batch "assets/*.glb" [--save f]` | Gather many files into ONE scene; per-file results, failures do not stop the rest. |
| `generate "<prompt>" [--out f.glb] [--import] [--wait sec]` | Text-to-3D via [Meshy](https://www.meshy.ai) (`MESHY_API_KEY` required): submit, poll, download the GLB, optionally chain into the scene. |
| `generate --image ref.png [--out f.glb] [--import]` | Image-to-3D from a reference photo (`png jpg webp`); a prompt given alongside becomes the texture prompt. |
| `export <out> [--blend f] [--selected] [--no-verify] [--strict]` | Hand the scene on: `glb gltf obj fbx stl ply usd`. Reads the file back and reports a `fidelity` census (meshes, verts, materials, UV layers, colour attrs, shape keys), scoped to what the format can carry. |
| `export <out-dir> --batch "blends/*.blend" --format glb` | One export per `.blend`, named after its source. |
| `render [--blend f] --out p.png [--frame N] [--res WxH] [--engine E] [--device D] [--samples N] [--denoise on\|off]` | Single-frame preview with a verifiable result: engine, resolution, samples, duration, bytes. |
| `render --animation --out clip.mp4 [--frames 1..48] [--fps 24] [...]` | Render the frame range: MP4/MOV/WEBM via Blender's ffmpeg, or a PNG sequence for any other `--out`. |
| `render --batch "shots/*.blend" --out renders/ [--ext png]` | One render per `.blend`; `--out` is a directory. |
| `version` | Print name and version. |

Batch patterns must be quoted so the shell does not expand them first; `*` and `?` work in the last path segment, `**` does not.

## Blender version support

`doctor` reports `tested` only for versions this release was actually exercised against, and `untested` for everything else — it will not tell you a version works because it probably does. The matrix comes back as `tested_versions` in the JSON.

| Version | Status |
|---|---|
| 4.3.2 | tested — `node test/smoke.mjs` green (35/35) |
| 5.2.0 LTS | tested — `node test/smoke.mjs --blender <path>` green (35/35) |
| 3.0 – 5.x, otherwise | untested; engines and import/export operators are resolved from the running build, so it may well work. [Report breakage.](https://github.com/renezander030/blender-cli/issues) |
| below 3.0 | unsupported |

## How it works

Each command writes a tiny Python wrapper to a temp file and runs `blender --background [file.blend] --python wrapper.py`. The wrapper:

1. parses `PARAMS` (your flags, JSON-encoded, no shell-quoting hazards),
2. executes the `bpy` body with `stdout` captured, so agent `print()` calls come back as `logs` instead of vanishing,
3. emits one sentinel-delimited, base64-armored JSON line with `ok`, `result`, `ms` and optional `logs`, which the CLI extracts from Blender's noisy output (agent output can never collide with the delimiters),
4. exits nonzero on failure, with `error` and the full Python `trace` in the JSON.

State lives in `.blend` files you name; the CLI holds none. Runs compose like any Unix pipeline.

Blender never inherits the agent's stdin — a child holding an inherited pipe can block forever waiting on input nobody sends, which is the usual cause of a headless hang on Windows.

**Environment:** `BLENDER_BIN` overrides the binary path. Auto-detection order: `--blender` flag, `BLENDER_BIN`, platform install paths (macOS app bundle; `/usr/bin`, snap, flatpak on Linux; `Program Files`, Steam, Microsoft Store, scoop and Chocolatey on Windows), then `PATH`.

## Tests

```bash
node test/smoke.mjs                          # against whatever `blender` resolves to
node test/smoke.mjs --blender /path/to/blender
```

35 end-to-end checks against a real Blender — no mocking of the boundary, because the boundary (operator names, engine identifiers, exporter behaviour) is exactly what drifts between versions. A version only joins the tested matrix once this passes on it.

## License

MIT. See [LICENSE](./LICENSE).

> **Disclaimer:** Independent, community project. **Not affiliated with, sponsored by, or endorsed by** the Blender Foundation. "Blender" is a trademark of the Blender Foundation, used here only for identification (nominative) purposes. The blender-cli logo is an original mark and deliberately distinct from the Blender logo, which is a registered property of the Blender Foundation.
