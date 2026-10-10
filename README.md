<p align="center">
  <img src="https://raw.githubusercontent.com/renezander030/blender-cli/master/assets/logo.svg" alt="blender-cli: Blender, driven by your agent. JSON in, bpy runs headless, JSON out." width="720">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/blender-cli"><img src="https://img.shields.io/npm/v/blender-cli.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/blender-cli.svg" alt="node"></a>
  <img src="https://img.shields.io/badge/Blender-3.0%2B%20(tested%204.3%20%2B%205.2%20LTS)-0d9488" alt="Blender 3.0+, tested on 4.3 and 5.2 LTS">
  <img src="https://img.shields.io/badge/dependencies-zero-0d9488" alt="zero dependencies">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/blender-cli.svg" alt="license"></a>
</p>

**Your agent writes the `bpy`. This runs it.** `blender-cli` is a zero-dependency, single-file CLI that turns a local Blender install into a deterministic boundary an LLM agent can drive: it runs agent-authored Python headless (`blender --background`), captures one clean JSON result out of Blender's noisy stdout, and hands it back. Scaffold a scene, build objects, keyframe motion, render the proof, export the asset. No MCP server, no HTTP daemon, no add-on, no API key.

```bash
npm install -g blender-cli && blender-cli doctor
```

## New in v0.8.0

Nine additions make agent runs safer to approve, easier to review and easier to undo. The 117-check suite passes on Blender 4.3.2 and 5.2.0 LTS:

- **Allowlisted `--safe` imports.** Safe-mode code imports from a fixed allowlist (`bpy`, `bmesh`, `mathutils`, `numpy`, `math`, `random`, `json` and other pure-computation modules), checked statically and again at runtime. Private and dunder attributes, module objects re-exported by allowed modules, computed `getattr` escapes, `Text.as_module`, preset and script runners, and write-mode `open` are refused. Script auto-execution stays off for the run.
- **Approval binding.** `exec --check` and `run --check` report `code_sha256`. `--expect-sha256 <hex>` runs the code only when it hashes to the reviewed value, so an approval covers exactly the code that executes.
- **Save versions.** `--save` over an existing scene keeps the replaced file as `scene.blend1` (rotating to `.blend2` and beyond when Blender's Save Versions preference asks for it) and reports it as `saved_artifact.backup`. `--no-backup` skips it.
- **Change summaries.** `--diff` on `exec`, `run`, `add`, `keyframe`, `material` and `import` compares the scene before and after the command in the same session and returns `changes`: added, removed and changed objects with the changed fields, plus changed scene settings.
- **Import arrival check.** An import that adds no objects fails with an actionable error (`--allow-empty` accepts it). Every import reports each arrived object's parent and the hierarchy roots; `scene` reports parents too.
- **API drift for 4.x and 5.x.** The drift guard names `use_auto_smooth` (4.1), `calc_normals`/`calc_normals_split` (4.0/4.1), face maps and node-group `inputs.new` (4.0), `shadow_method` (4.2), the `bgl` module and VSE `sequences` (5.0), each with its replacement.
- **Readable node discovery.** `nodes find` returns each node's UI label and description, matches searches against them, and leaves out abstract base classes.
- **Stall detection.** Running jobs report `idle_s`, the seconds since Blender last wrote output. `job wait --stall-after <sec>` returns `stalled: true` when that passes the limit and leaves the job running for you to inspect or cancel.
- **Provider requests with deadlines and retries.** Poly Haven and Meshy requests time out (`BLENDER_CLI_HTTP_TIMEOUT`, default 60 s; downloads `BLENDER_CLI_DOWNLOAD_TIMEOUT`, default 600 s) and retry transient failures with `Retry-After` or exponential backoff (`BLENDER_CLI_HTTP_RETRIES`, default 3). Generation requests are retried only when the provider refused them.

Safe mode refuses imports outside its allowlist; pass `--unsafe` for code that needs other modules.

## New in v0.7.0

Nine additions make scene edits, acceptance and asset delivery easier to check:

- Export readback counts evaluated geometry, including text, curves, metaballs and collection instances. `--strict` fails when readback is unavailable, and cannot be combined with `--no-verify`.
- Scene saves write a temporary sibling first, check that the destination still matches its starting hash, and atomically replace it. Results include `saved_artifact` with the final SHA-256 and size.
- Acceptance specs reject unknown fields, invalid nested rules and incorrectly typed values. Batch rendering checks each scene and writes a separate receipt and optional snapshot for it.
- `export --options '{"export_apply":true}'` (or `--options @export.json`) validates format-specific settings against the running Blender's operator API. Output, selection and animation switches remain controlled by the CLI.
- Batch render/export can write a `--manifest progress.json` and `--resume`. A completed item is skipped only when its scene, settings, recorded dependencies, output files and optional acceptance receipt still match.
- `diff before.blend after.blend` reports added, removed and changed objects, hierarchy, world transforms, evaluated geometry, bounds, material assignments and scene settings. `--fail-on-change` gives comparisons a non-zero exit when they differ.
- `assets search wood --type texture --category wood` discovers Poly Haven asset IDs by name, category and tags. Results include import IDs, CC0 attribution and source URLs, with a one-hour catalogue cache.
- glTF exports validate and hash their referenced local buffers and textures as well as the main JSON file. `exported.artifacts` lists every member and `bundle_sha256` binds their URI, size and hash.
- `receipt verify acceptance.receipt.json` checks that a passing acceptance receipt still matches the current scene, spec and optional snapshot.

Acceptance validation is stricter in this release: numeric strings, booleans used as counts and misspelled rule names are rejected. Existing correctly typed specs continue to work.

## New in v0.6.0

Nine reliability improvements make long headless runs and saved assets easier to trust. The 86-check suite passes on Blender 4.3.2 and 5.2.0 LTS:

- Temporary Blender scripts, safe-mode code and snapshot tiles are cleaned after each synchronous run, including failures.
- Detached jobs enforce `--timeout` without waiting for a `job status` poll. Cancellation stops the Blender process tree, and the supervisor cleans its temporary scripts.
- A `.blend` saved by a newer Blender now reports the file and running versions, with an actionable `--blender` hint when the older binary exits before returning JSON.
- Poly Haven texture imports download the maps they can connect by default, prefer OpenGL normal maps, wire displacement to the material output and report unused maps. `--maps` still chooses an explicit set.
- Asset downloads reject empty or size-mismatched responses and atomically replace cache files only after validation.
- `verify` and `accept` flag missing external image files before a render silently loses textures.
- `nodes inspect` reads the Blender 5 compositor group as well as the legacy scene node tree.
- Batch import removes objects left by a failed file before trying the next asset; each failed item reports the rollback count.
- `schema --compact` returns a smaller JSON command manifest for agent contexts while preserving command names, effects, usage and flag names.

## New in v0.5.0

Nine additions make an automated Blender run discoverable before execution and provable afterward:

- **Two-version conformance.** The 81-check suite passes on Blender 4.3.2 and 5.2.0 LTS. `doctor` now reports import and export capabilities separately and names build-specific limitations; unavailable operators fail with the matching capability path.
- **Deep export fidelity.** Readback covers faces, loops, material slots and colour-channel variance as well as geometry, materials, UVs, shape keys and animation, catching channels that survive by name but collapse to a flat value.
- **Artifact proof.** Every render and export verifies a non-empty output and returns its SHA-256. Video results include the actual container/codec; image sequences use a stable aggregate hash.
- **`nodes find|inspect`.** Discover the node types exposed by the running Blender, or inspect a wildcard-filtered, size-bounded graph of nodes, sockets and links from a `.blend`.
- **`accept`.** A JSON spec can require objects/types, frame range, clean verification and minimum snapshot coverage. The result is an atomic receipt bound to the spec, source `.blend` and visual-proof hashes. `render --accept spec.json` refuses the expensive render when the gate fails.
- **Hardened `--safe`.** Blender script-directory persistence, preference saving and reflection escapes are blocked by the AST gate.
- **Attributable, persistent assets.** Poly Haven imports report provider URL, CC0 license and cache location; `--maps` limits texture downloads and `--pack` embeds downloaded images in the saved scene.
- **One-command agent setup.** `install codex|claude|all|doctor` writes or checks the generated skill idempotently. `schema --command ... --effects ...` keeps agent context scoped to the commands it needs.
- **`camera`.** Camera calibration JSON includes a sensor-shift and pixel-aspect aware K matrix, Blender/OpenCV extrinsics, coordinate conventions and a principal-point reprojection check.

## New in v0.4.0

Nine additions. The theme: **the agent can now build, look, and ship without writing bpy, and without outliving its own tool-call limit.**

- **Add-ons, headless.** `addon list [--all] | enable <module> | disable <module> | install <file.py|.zip> [--enable]`, plus `--addons a,b` on every Blender-running command to enable modules for one call. Blender's own `--addons` flag only warns on a missing module and carries on; here a missing module is a loud error that names what is installed. Pipelines that need an importer add-on kept hanging on startup or running silently without it ([awful-studio#10](https://github.com/looksawful/awful-studio/issues/10), [ComfyUI-SkinTokens#5](https://github.com/Aero-Ex/ComfyUI-SkinTokens/issues/5)).
- **`--detach` and `job`.** A long animation render outlasts most agent tool-call limits (Claude Code kills a shell call after 2 minutes by default; MCP clients give up around 5, [blender-mcp#279](https://github.com/ahujasid/blender-mcp/issues/279)). `render --detach` (and `exec --detach`) returns a job id at once; `job status <id>` reads frames done and percent from Blender's own console, `job wait <id> --timeout 600` collects the final result, `job cancel <id>` kills it, `job list` shows them all.
- **`snapshot`.** Front, right, top and a fitted 3/4 perspective, rendered with Workbench in one Blender launch and tiled into one PNG, with per-view **coverage** (fraction of pixels the geometry occupies, from the alpha channel), occupied bounding box, mean luminance and a `blank` flag. An agent can tell "framed and visible" from "off to one side" without an image model in the loop, which is what verification-as-a-toolset asks for ([dcc-mcp-core#2261](https://github.com/dcc-mcp/dcc-mcp-core/issues/2261)).
- **`add`, `keyframe`, `material`.** Build without bpy: primitives, camera (with `--look-at`), lights, empties and text by name; keyframes on `location|rotation|scale` or any dotted data path (`data.energy`), rotation in degrees, `--interp`, frame range extended to the keyed frame; a Principled material with the 4.0+ socket names. `--json` runs a whole batch in one launch. Every op addresses objects by name and returns the resulting state, so the `active_object` context can never silently retarget the wrong mesh. Typed vocabulary for exactly this was the ask in [dcc-mcp-maya#493](https://github.com/dcc-mcp/dcc-mcp-maya/issues/493).
- **`schema`.** The whole command surface as JSON, each command annotated with its **effects** (`read`, `scene`, `files`, `code`, `network`, `prefs`, `process`), flags and usage; `schema --skill` renders a drop-in SKILL.md. Harnesses asked for tool annotations and a single entry point instead of scraping help text ([blender-mcp#328](https://github.com/ahujasid/blender-mcp/issues/328), [blender-skills#1](https://github.com/arjun988/blender-skills/pull/1)).
- **Version-aware API guard.** Blender 4.4 made actions slotted and 5.0 removed `Action.fcurves`, which meant `scene` on 0.3.0 crashed on *any animated file* under 5.x (`'Action' object has no attribute 'fcurves'`). Fixed, through a reader that handles both APIs. Beyond that, `exec --check` now reports `api_drift`: the known moves (slotted actions, `Scene.node_tree` → `compositing_node_group`, `import_scene.obj` → `wm.obj_import`, the EEVEE renames, the 4.0 Principled socket renames, context-dict overrides, ...) that apply to **the build in use**, each with the replacement, and a failed `exec` on one of them carries the same hint. `doctor` reports the live `api` generation. The ecosystem keeps breaking on exactly this ([blender-mcp#339](https://github.com/ahujasid/blender-mcp/issues/339), [Blender-For-UnrealEngine-Addons#253](https://github.com/xavier150/Blender-For-UnrealEngine-Addons/issues/253)).
- **`render --device auto`, `--threads N`.** Auto picks OPTIX > CUDA > HIP > METAL > ONEAPI and falls back to CPU, and the render result now says which device and how many threads actually rendered. Headless and container runs had no way to ask for "whatever GPU there is" ([tut#1069](https://github.com/BenjaminBenetti/tut/issues/1069)).
- **`verify` mesh health.** A bmesh pass per mesh: loose vertices and edges, non-manifold edges, zero-area faces, inconsistent winding, inverted normals on a closed mesh, non-convex `UCX_`/`UBX_`/`USP_`/`UCP_` game-engine colliders (an error: engines import them silently and collide wrongly), and modifier-stack order (Multires not last, Mirror after Subdivision). `--no-mesh` skips it ([cc-blender-skill#2](https://github.com/RobLe3/cc-blender-skill/pull/2)).
- **Export census covers animation.** An exported glb/fbx that silently dropped its motion used to pass fidelity; `animated` (objects with two or more keys) is now compared for the formats that round-trip it, and USD, which Blender writes with animation but does not read back as keyframes, is not judged on it. `--animations off` turns export off and says so ([Blender-For-UnrealEngine-Addons#253](https://github.com/xavier150/Blender-For-UnrealEngine-Addons/issues/253), [glTF-Blender-IO#2751](https://github.com/KhronosGroup/glTF-Blender-IO/issues/2751)).

The suite grew from 35 to 71 checks and was run green on Blender 5.1.1; that is the tested matrix for this release (see below).

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

Gate a deliverable with a declarative acceptance spec and keep a hash-bound receipt:

```json
{
  "version": 1,
  "required_objects": [{ "name": "Camera", "type": "CAMERA" }, "Cube"],
  "forbidden_objects": ["__draft_*"],
  "required_types": { "MESH": 1 },
  "frame_range": [1, 24],
  "max_errors": 0,
  "max_warnings": 2,
  "snapshot": {
    "out": "proof.png",
    "views": "front,right,top,persp",
    "res": "256x192",
    "min_coverage": 0.01
  }
}
```

```bash
blender-cli accept acceptance.json --blend demo.blend --receipt acceptance.receipt.json
blender-cli render --blend demo.blend --out final.png --accept acceptance.json
```

Or build the same thing without writing any bpy, look at it, and hand a long render off to a job:

```bash
blender-cli add cube --name Box --at 0,0,1 --blend demo.blend --save demo.blend
blender-cli material Box --color '#cc2222' --roughness 0.3 --blend demo.blend --save demo.blend
blender-cli keyframe --json '[{"object":"Box","prop":"location","frame":1,"value":[0,0,0]},
                             {"object":"Box","prop":"location","frame":24,"value":[0,0,2.5]}]' --blend demo.blend --save demo.blend
blender-cli snapshot --blend demo.blend --out sheet.png      # front/right/top/persp + coverage per view
blender-cli render --animation --blend demo.blend --out bounce.mp4 --frames 1..24 --detach
blender-cli job wait <id> --timeout 600                      # progress while it runs, the result when done
```

Safety-check agent code before it touches anything (`api_drift` lists the API moves that apply to *this* Blender):

```bash
blender-cli exec 'import os; os.system("rm -rf /")' --check
# {"ok":true,"result":{"compiles":true,"warnings":[{"call":"os.system","risk":"shell command"}],"bpy_version":[5,1,1],"checked_only":true,"api_drift":[]}}
```

## Commands

One JSON object on stdout per invocation; exit code 1 exactly when `ok` is false. Add `-H` for a pretty-printed view. `--timeout <sec>`, `--blender <path>` and `--addons a,b` work on every Blender-running command. `blender-cli schema` gives you this table as JSON with effects annotations; `schema --skill` as a SKILL.md.

| Command | What it does |
|---------|--------------|
| `doctor` | Locate Blender, verify headless `bpy`, report version support, import/export formats, video support, engines, GPU devices, enabled add-ons and the live `api` generation (slotted vs legacy actions, compositor tree, OBJ/STL operators). **Run this first.** |
| `new <name> [--save f.blend]` | Scaffold a clean project (camera + key light + 1080p). |
| `exec "<bpy>" [--blend f] [--save f] [--check] [--safe] [--detach]` | Run agent-authored `bpy`; set keys on `result` and they come back as JSON. `--check` compiles, flags risky calls and reports version-specific `api_drift` without executing; `--safe` refuses code that trips the AST gate; `--detach` runs it as a job. A failed exec on a known API move carries the hint. |
| `run <script.py> [--blend f] [--save f] [--check] [--safe] [--detach]` | Same, from a `.py` file. |
| `scene [--blend f]` | Dump objects (transforms, `fcurves`, `keyframes`, keyed `frames`), frame range, engine, resolution, materials, cameras and lights as JSON. |
| `nodes find [--kind geometry\|shader\|compositor\|all] [--search pattern] [--limit N]` | Discover the node vocabulary available in the running Blender, bounded for agent context. |
| `nodes inspect [--group pattern] [--blend f] [--limit N]` | Inspect filtered node groups, sockets and dependency links without dumping the whole file. |
| `camera [name] [--blend f] [--frame N]` | Report camera K, Blender/OpenCV extrinsics, sensor/pixel metadata, coordinate convention and a principal-point reprojection check. |
| `verify [--blend f] [--tolerance 0.001] [--fail-on error\|warn\|none] [--no-mesh]` | Lint the scene: missing camera, empty meshes, NaN/degenerate transforms, unapplied non-uniform scale, off-camera objects, real overlaps, plus per-mesh health: loose geometry, non-manifold edges, zero-area faces, inconsistent/inverted normals, non-convex `UCX_` colliders, Multires-not-last and Mirror-after-Subsurf stacks. Tiered error/warn/info; touching is not overlapping. |
| `snapshot [--blend f] --out sheet.png [--views front,right,top,persp] [--res 512x384] [--shading random\|material\|solid] [--frame N]` | Workbench contact sheet in one launch, with per-view coverage, occupied bbox, luminance and a `blank` flag. Views: `front back right left top bottom persp`. |
| `accept <spec.json> --blend f [--receipt result.json]` | Apply declarative scene, verification and visual-coverage requirements; write a receipt bound to the spec, source and snapshot hashes. |
| `add <kind> [--name N] [--at x,y,z] [--rot x,y,z] [--size N] [--scale x,y,z] [--look-at x,y,z] [--type T] [--energy N] [--color c] [--text T]` | Add `cube sphere icosphere plane cylinder cone torus monkey camera light empty text` by name. `add --json '[...]'` runs a batch in one launch. Returns the objects as built. |
| `keyframe <object> --frame N [--prop location\|rotation\|scale\|<data.path>] [--value x,y,z] [--interp linear\|bezier\|constant] [--no-extend]` | Set a property and key it (rotation in degrees; dotted paths like `data.energy` work); the frame range grows to the keyed frame unless `--no-extend`. `keyframe --json '[...]'` batches. Reads both legacy and slotted actions. |
| `material <object> [--name M] [--color r,g,b\|#hex] [--roughness x] [--metallic x] [--alpha x] [--emission c] [--emission-strength x]` | Create or update a Principled BSDF material (4.0+ socket names, with fallbacks) and assign it. |
| `import <file> [--blend f] [--save f]` | Pull an asset in: `glb gltf obj fbx stl ply usd usda usdc usdz abc dae`; a local `.hdr`/`.exr` becomes the world environment. Reports what arrived (objects, types, vert count). |
| `import polyhaven:<id> [--type hdri\|texture\|model] [--res 1k\|2k\|4k] [--maps a,b] [--pack]` | Fetch + import a [Poly Haven](https://polyhaven.com) asset with provider/license/cache provenance; optionally select texture maps and pack images into the `.blend`. |
| `import --batch "assets/*.glb" [--save f]` | Gather many files into ONE scene; per-file results, failures do not stop the rest. |
| `generate "<prompt>" [--out f.glb] [--import] [--wait sec]` | Text-to-3D via [Meshy](https://www.meshy.ai) (`MESHY_API_KEY` required): submit, poll, download the GLB, optionally chain into the scene. |
| `generate --image ref.png [--out f.glb] [--import]` | Image-to-3D from a reference photo (`png jpg webp`); a prompt given alongside becomes the texture prompt. |
| `export <out> [--blend f] [--selected] [--no-verify] [--strict] [--animations on\|off]` | Hand the scene on: `glb gltf obj fbx stl ply usd`. Returns an artifact hash and reads the file back for format-aware geometry, material, UV, colour-variance, shape-key and animation fidelity. |
| `export <out-dir> --batch "blends/*.blend" --format glb` | One export per `.blend`, named after its source. |
| `render [--blend f] --out p.png [--frame N] [--res WxH] [--engine E] [--device auto\|cpu\|cuda\|optix\|metal\|hip\|oneapi] [--threads N] [--samples N] [--denoise on\|off] [--accept spec.json] [--detach]` | Render with engine/device metadata and a non-empty SHA-256 artifact proof. `--accept` runs the declarative gate first and blocks on failure. |
| `render --animation --out clip.mp4 [--frames 1..48] [--fps 24] [--detach] [...]` | Render the frame range: MP4/MOV/WEBM via Blender's ffmpeg, or a PNG sequence for any other `--out`. `--detach` returns a job id immediately. |
| `render --batch "shots/*.blend" --out renders/ [--ext png]` | One render per `.blend`; `--out` is a directory. |
| `job list \| status <id> \| wait <id> [--timeout sec] [--poll sec] \| cancel <id>` | The other half of `--detach`: frames done (and percent when the range is known) while it runs, the final result once Blender is finished. Jobs live in `~/.cache/blender-cli/jobs` (`BLENDER_CLI_JOBS_DIR` overrides). |
| `addon list [--all] \| enable <module> [--no-persist] \| disable <module> \| install <file.py\|.zip> [--enable]` | Add-ons and extensions without a UI. `enable` persists to user preferences (the point of it); `--no-persist` tries it for the one call. `install` takes a legacy add-on or an extension package (`blender_manifest.toml`, 4.2+). |
| `install codex\|claude\|all\|doctor [--global]` | Idempotently install or verify the generated Blender CLI skill for agent clients. |
| `schema [--command a,b] [--effects read,files] [--compact] [--skill] [--out file]` | The full, scoped or compact command surface as JSON with effects annotations, or as a drop-in SKILL.md. |
| `version` | Print name and version. |

Batch patterns must be quoted so the shell does not expand them first; `*` and `?` work in the last path segment, `**` does not.

## Blender version support

`doctor` reports `tested` only for versions this release was actually exercised against, and `untested` for everything else — it will not tell you a version works because it probably does. The matrix comes back as `tested_versions` in the JSON.

| Version | Status |
|---|---|
| 4.3.2, 5.2.0 LTS | tested — the v0.7.0 suite passes 106/106 on both builds. |
| 3.0 – 5.x, otherwise | untested; engines and import/export operators are resolved from the running build, so it may well work. [Report breakage.](https://github.com/renezander030/blender-cli/issues) |
| below 3.0 | unsupported |

`doctor.io` reports import and export support separately because distro builds can omit an operator. For example, the tested 4.3.2 package has no USD importer/exporter; requesting USD export fails clearly with `doctor.io.usd.export=false` instead of crashing inside `bpy`.

## How it works

Each command writes a tiny Python wrapper to a temp file and runs `blender --background [file.blend] --python wrapper.py`. The wrapper:

1. parses `PARAMS` (your flags, JSON-encoded, no shell-quoting hazards),
2. executes the `bpy` body with `stdout` captured, so agent `print()` calls come back as `logs` instead of vanishing,
3. emits one sentinel-delimited, base64-armored JSON line with `ok`, `result`, `ms` and optional `logs`, which the CLI extracts from Blender's noisy output (agent output can never collide with the delimiters),
4. exits nonzero on failure, with `error` and the full Python `trace` in the JSON.

State lives in `.blend` files you name; the CLI holds none. Runs compose like any Unix pipeline.

Blender never inherits the agent's stdin — a child holding an inherited pipe can block forever waiting on input nobody sends, which is the usual cause of a headless hang on Windows.

**Environment:** `BLENDER_BIN` overrides the binary path. Auto-detection order: `--blender` flag, `BLENDER_BIN`, platform install paths (macOS app bundle; `/usr/bin`, snap, flatpak on Linux; `Program Files`, Steam, Microsoft Store, scoop and Chocolatey on Windows), then `PATH`. `BLENDER_CLI_SAFE=1` makes `--safe` the default; `BLENDER_CLI_JOBS_DIR` relocates detached jobs; `MESHY_API_KEY` enables `generate`.

**Detached jobs:** `--detach` spawns Blender unref'd with stdout/stderr going to `~/.cache/blender-cli/jobs/<id>/`. `job status` parses Blender's own per-frame console lines for progress until the sentinel result appears, so nothing else is running in between: no daemon, no socket, just a process and a log.

## Comparing, resuming and verifying delivery

```bash
blender-cli diff original.blend candidate.blend --fail-on-change
blender-cli assets search "wooden table" --type model --limit 5
blender-cli export model.gltf --blend scene.blend --strict --options '{"export_apply":true}'
blender-cli render --batch "shots/*.blend" --out renders/ --engine workbench \
  --manifest render-progress.json
blender-cli render --batch "shots/*.blend" --out renders/ --engine workbench \
  --manifest render-progress.json --resume
blender-cli export exports/ --batch "shots/*.blend" --format gltf \
  --strict --manifest export-progress.json --resume
blender-cli receipt verify acceptance.receipt.json
```

A diff compares the saved frame unless `--frame` selects the same frame in both files. `--tolerance` defaults to `0.000001` for numeric transforms and bounds; the geometry digest rounds local vertex coordinates to six decimal places and includes polygon topology and material indices. A changed state is a factual report, not a quality judgment. The comparison covers the fields listed above; it does not compare shader socket values, every modifier parameter or sampled animation curves.

`--options` accepts a JSON object or `@file.json`. Keys and value types must exist in the installed export operator; enum values and numeric ranges are checked there. The CLI reserves `filepath`, `directory`, `files`, `check_existing`, format, selection and animation controls. Use the corresponding CLI switches for those settings. An option available on one Blender build can correctly fail on another.

Manifests are optional and apply to batch render/export. Keep the same output directory and work settings on a resumed invocation. Each item records scene and output hashes, local file images and linked libraries, and any acceptance receipt. Changed or missing recorded files force that item to run again. Image sequences, tiled textures and movie textures disable reuse; simulation caches and remote dependencies are not fully tracked, so rerun without `--resume` when those inputs change. Failed items are recorded and retried while other files continue. A manifest must end in `.json` and be separate from sources, dependencies, acceptance specs and output files. An existing path must contain a valid blender-cli batch manifest; unrelated JSON files are rejected even without `--resume`.

For `render --batch ... --accept spec.json`, each scene is checked separately. Receipts default to `<output-dir>/<scene>.acceptance.receipt.json`; `--receipt <directory>` changes their directory. Snapshot proof uses a separate `<scene>.acceptance.snapshot.png` for every scene, overriding the single-file `snapshot.out` setting in batch mode.

Receipt verification checks file contents and a recorded passing decision. It does not authenticate who created a receipt. Keep receipts with their artifacts; paths are absolute, so moving an artifact requires rerunning acceptance to produce new evidence.

Poly Haven search uses case-insensitive text matching, with exact and prefix matches first. `--refresh` refreshes the catalogue; `BLENDER_CLI_CACHE_DIR` can move the search cache. Powered by [Poly Haven](https://polyhaven.com). Search does not download asset files. Imports retain their existing download cache.

## Tests

```bash
npm test                                    # against whatever `blender` resolves to
npm test -- --blender /path/to/blender
node test/release.mjs --blender /path/to/blender  # v0.7 regressions only
node test/v080.mjs --blender /path/to/blender     # v0.8 checks only
```

117 end-to-end checks (86 smoke checks, 20 v0.7 regressions and 11 v0.8 checks) run against a real Blender. The v0.8 checks run provider retries against a local stand-in server. Release regressions also inject an unavailable importer to check the failure contract and use a cached catalogue fixture to check asset discovery. A version only joins the tested matrix once this passes on it. The add-on checks run against isolated Blender preferences (`BLENDER_USER_RESOURCES`) and the job checks against a throwaway jobs directory, so the suite never touches the host's Blender configuration or job cache. Separate publishing policy checks exercise the owner/commit review gate, version matching and registry conflicts without publishing.

## License

MIT. See [LICENSE](./LICENSE).

> **Disclaimer:** Independent, community project. **Not affiliated with, sponsored by, or endorsed by** the Blender Foundation. "Blender" is a trademark of the Blender Foundation, used here only for identification (nominative) purposes. The blender-cli logo is an original mark and deliberately distinct from the Blender logo, which is a registered property of the Blender Foundation.

## Release publishing

Pull requests run the complete suite against Blender 4.3.2 and 5.2.0. After the repository owner merges a `release/v<version>` PR and the checks pass on that exact `master` commit, the publishing workflow releases the matching npm package with provenance and creates a GitHub Release with the tarball and SHA-256 checksum. It requires an `NPM_TOKEN` repository secret with publishing access. Direct pushes and unsuccessful checks do not publish. Already published identical packages are reused; version or tag conflicts fail visibly.

This repository distributes a JavaScript CLI on npm. It does not distribute a Python package or implement an MCP server.
