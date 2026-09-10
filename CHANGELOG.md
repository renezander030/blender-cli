# Changelog

## 0.4.0 (2026-09-10)

Nine additions. Theme: **build, look and ship without writing bpy, and without outliving your own tool-call limit.** The suite grew from 35 to 71 checks, run green on Blender 5.1.1.

### Added

- `addon list [--all] | enable <module> [--no-persist] | disable <module> [--no-persist] | install <file.py|.zip> [--enable]`: add-ons and extensions headless. `enable` persists to user preferences by default; `install` handles legacy add-ons and extension packages (`blender_manifest.toml`, 4.2+). Every Blender-running command also accepts `--addons a,b` for one call; Blender's own `--addons` only warns on a missing module, so the wrapper re-checks and fails loudly, listing what is installed.
- `--detach` on `render`, `exec` and `run`, plus `job list | status <id> | wait <id> [--timeout sec] [--poll sec] | cancel <id>`. A detached run returns a job id at once; status reports frames done (and percent when the frame range was given) parsed from Blender's own console lines (`Fra:`, `Saved:`, `Append frame`, with the 5.x timestamp prefix), then the final result. Jobs live in `~/.cache/blender-cli/jobs` (`BLENDER_CLI_JOBS_DIR` overrides). `--timeout` on a detached run is enforced by `job status`.
- `snapshot [--blend f] --out sheet.png [--views ...] [--res WxH] [--shading random|material|solid] [--frame N]`: Workbench renders of front/right/top (orthographic, fitted to the scene bounds) and a fitted 3/4 perspective, tiled into one PNG, with per-view coverage (from the alpha channel), occupied bbox, luminance and a `blank` flag. Fails loudly when nothing is visible.
- `add <kind> ...` / `add --json '[...]'`: primitives (`cube sphere icosphere plane cylinder cone torus monkey`), `camera` (with `--look-at`), `light` (`--type --energy --color`), `empty`, `text`, all by name, batch in one launch, returning the objects as built.
- `keyframe <object> --frame N [--prop ...] [--value ...] [--interp ...] [--no-extend]` / `keyframe --json '[...]'`: sets and keys `location|rotation|scale` (rotation in degrees) or any dotted data path (`data.energy` keys the data block); extends the scene frame range to the keyed frame; reads legacy and slotted actions alike.
- `material <object> [--name] [--color r,g,b|#hex] [--roughness] [--metallic] [--alpha] [--emission] [--emission-strength]`: Principled BSDF with the 4.0+ socket names (falls back to older names), assigned to slot 0.
- `schema [--skill] [--out file]`: the whole command surface as JSON, each command annotated with effects (`read scene files code network prefs process`), flags, usage and summary; `--skill` renders a drop-in SKILL.md. The smoke suite fails if the spec set and the command set diverge.
- **API drift guard.** A table of known bpy moves keyed to the Blender version they landed in (`Action.fcurves` removal, `Scene.node_tree` → `compositing_node_group`, `use_nodes` deprecation, `import_scene.obj` / `import_mesh.stl` removals, both EEVEE renames, the 4.0 Principled socket renames, context-dict overrides, `Object.select`, `scene.objects.active`, HEMI lights, `"rotation"` as a data path). `exec --check` reports the rows that apply to the build in use as `api_drift`; a failed `exec`/`run` appends the matching hints. `doctor` reports the live `api` generation (`actions`, `compositor`, `eevee_engine_id`, `obj_io`, `stl_io`, `extensions`) and `addons_enabled`.
- `render --device auto` (OPTIX > CUDA > HIP > METAL > ONEAPI, else CPU) and `--threads N`; the render result now carries `device` (requested, type, names) and `threads`.
- `verify` mesh health, per mesh via bmesh: `loose_geometry`, `non_manifold`, `zero_area_faces`, `inconsistent_normals`, `inverted_normals`, `open_mesh` (info), `concave_collider` (error, for `UCX_`/`UBX_`/`USP_`/`UCP_`-prefixed objects, tested on a triangulated copy), `multires_not_last` (error), `mirror_after_subsurf`, `modifiers_pending` (info); stats under `verified.mesh`; `--no-mesh` skips the pass; meshes over 500k vertices are skipped with a note.
- Export fidelity census compares `animated` (objects with two or more keys) for glb/gltf/fbx, which round-trip animation; USD is written with animation (`export_animation`) but not judged on it, since Blender's USD importer does not read it back as keyframes. `--animations on|off` controls export; `exported.animation` reports objects, keyframes and whether it was written.

### Fixed

- **`scene` crashed on any animated file under Blender 5.x** (`'Action' object has no attribute 'fcurves'`): 4.4 introduced slotted actions and 5.0 removed the legacy accessor. A version-aware reader now serves `scene`, `keyframe` and the export census.

### Changed

- `scene` objects report `fcurves`, `keyframes` (keyframe points) and `frames` (first and last keyed frame) instead of a single `keyframes` field that actually counted F-curves.
- `TESTED_VERSIONS` lists only what this release's suite was actually run on (5.1). 4.3.2 and 5.2.0 were green at 0.3.0 and rejoin the matrix once `node test/smoke.mjs --blender <path>` passes on them again; `doctor` reports them `untested` until then, by design.
- Blender 5.1.1's own FBX importer fails on scenes containing lights; an FBX export of such a scene now reports `fidelity.checked: false` with that reason (documented; the exporter itself is fine).

## 0.3.0 (2026-07-25)

Blender 5.x support, and a release theme of **trust the output**: 0.1.0 and 0.2.0 built the pipeline (import, generate, render, export), and this one makes what comes out of it checkable. Six items, each mined from cited, recent pain in the agent-Blender ecosystem, and the whole surface is now exercised by a smoke suite run against both Blender 4.3.2 and 5.2.0.

### Added

- **Blender 5.x support, actually tested.** The suite runs green on 4.3.2 and 5.2.0, and `TESTED_VERSIONS` lists only versions it was really run against. `doctor` now reports `tested` or `untested` and never `supported` for a version nobody exercised, plus the matrix itself as `tested_versions`.
- `verify [--blend f] [--tolerance 0.001] [--fail-on error|warn|none]`: lint a scene before spending a render on it. Errors for a missing camera, empty meshes, NaN/infinite transforms and degenerate (zero) scale; warnings for negative and unapplied non-uniform scale, off-camera objects, and real overlaps; info for missing materials and lights. Two objects merely touching are **not** an overlap: interpenetration has to exceed `--tolerance` on all three axes, and the depth is reported so you can judge. (This is the redesign of the check deliberately dropped in 0.2.0 for being too noisy to act on.)
- **Export fidelity census.** `export` now reads the written file back into an empty scene and compares it against what went in, reporting `fidelity` with per-field scene-vs-file counts for meshes, verts, materials, UV layers, colour attributes and shape keys. Comparison is scoped to what each container can actually carry, so STL is never accused of losing materials it cannot hold. `--no-verify` skips the readback, `--strict` makes a degraded export a non-zero exit.
- `generate --image <ref.png|jpg|webp>`: image-to-3D from a reference photo, alongside the existing text-to-3D. Shares the polling, download and `--import` path; a text prompt given with `--image` is passed as the texture prompt.
- **Batch mode.** `render --batch "shots/*.blend" --out renders/ [--ext png]` and `export <out-dir> --batch "blends/*.blend" --format glb` run one file at a time and name each output after its source; `import --batch "assets/*.glb"` gathers many files into a single scene. Every item runs even if an earlier one fails, each result is reported per file, and the exit code is non-zero if any failed. `*` and `?` in the last path segment; no `**`.
- `doctor` reports `cycles_denoiser`, so a build with no OpenImageDenoise is visible before a render fails rather than after.
- `test/smoke.mjs`: 35 end-to-end checks against a real Blender (`node test/smoke.mjs [--blender <path>]`). This is what backs the tested-version matrix.

### Fixed

- **`render --engine eevee` was broken on Blender 5.x.** EEVEE shipped as `BLENDER_EEVEE`, gained `BLENDER_EEVEE_NEXT` in 4.2, then took the plain name back in 5.0 — and the hardcoded identifier meant every EEVEE render on 5.x died with `enum "BLENDER_EEVEE_NEXT" not found`. The engine is now resolved from the enum the running build advertises, so the next rename is survivable too. `doctor` had been calling 5.x "supported (tested on 4.3)" the whole time.
- **Cycles renders failed outright on builds without OpenImageDenoise.** Denoising is on by Blender's default and a build compiled without OIDN then aborts the render with "Failed to denoise", never hinting the setting was optional — which is how most distro packages ship, so a plain `render --engine cycles` on a server was dead on arrival. Denoising now stands down automatically when no denoiser exists (reported in the result), while an explicit `--denoise on` fails with an error that says why.
- Blender no longer inherits the agent's stdin. A child holding an inherited stdin pipe can block forever waiting on input nobody sends — the classic headless hang on Windows, where `--timeout` was the only thing ending the call.
- Windows binary discovery now also covers Steam, Microsoft Store, scoop and Chocolatey layouts, not just `Program Files\Blender Foundation`.
- EEVEE sample counts are located by probing the build rather than assuming `taa_render_samples`.

## 0.2.0 (2026-07-18)

Ports the remaining unique features from the experimental TypeScript branch into the canonical zero-dependency implementation, with the known gaps in that branch fixed. The TS branch is archived as tag `archive/ts-rewrite`.

### Added

- `import polyhaven:<id> [--type hdri|texture|model] [--res 1k|2k|4k]`: fetch and import Poly Haven assets. Models import with all glTF texture sidecars, HDRIs become the world environment (Background + Environment Texture nodes), textures become a Principled BSDF material with Base Color/Roughness/Metallic/Normal/Alpha wired and correct color spaces. Downloads cache in `~/.cache/blender-cli/polyhaven` and are skipped on size match (the TS branch re-downloaded every time).
- `generate "<prompt>" [--out f.glb] [--import] [--wait sec] [--backend meshy]`: text-to-3D via the Meshy API (`MESHY_API_KEY` from the environment or the CLI-local `.env`, which the TS branch ignored). Submits a preview task, polls every 5 s until `--wait` (default 300 s), downloads the GLB, and with `--import` chains straight into the scene. `MESHY_API_BASE` can point at a mock for testing.
- `exec`/`run` `--safe`: an in-Blender AST gate that refuses agent code containing banned imports (`os`, `subprocess`, `socket`, `shutil`, `sys`, `ctypes`, `urllib`, `http`), `eval`/`exec`/`__import__`, write-mode `open()` (including pathlib's positional `Path.open("w")`, which slipped through the TS gate), `getattr` escapes, and system/filesystem escape attributes. Violations come back structured in `result.violations`. Clean code runs in a namespace containing only `bpy`, `PARAMS`, `result` (the TS gate executed in the wrapper's globals, where the banned `os`/`sys` modules were already imported). `BLENDER_CLI_SAFE=1` makes safe mode the default; `--unsafe` overrides.
- Failed runs now include any partial `result` the agent set before the exception.

### Not ported (deliberately)

- The TS branch's `add`/`keyframe` verbs: they duplicate what `exec` does and cut against the core architecture decision that the agent writes the bpy.
- The TS branch's `verify` scene lint: its bounding-box overlap check fires on any object resting on another (touching counts as overlap), which makes it noisy on normal scenes. Recorded as an opportunity-graph candidate to redesign properly.

## 0.1.0 (2026-07-18)

The release that takes blender-cli from a headless executor to a full agent pipeline: assets in, animation out, renders you can verify, and guardrails around agent-authored code. Every item was mined from recurring, cited pain in the agent-Blender ecosystem and verified end-to-end against Blender 4.3.

### Added

- `import <file>`: pull assets into the scene: glTF/GLB, OBJ, FBX, STL, PLY, USD/USDA/USDC/USDZ, Alembic, Collada. Returns imported object names, types and vertex counts. Legacy operators are used automatically on Blender versions below 4.x.
- `export <out>`: hand the scene to the next tool: glTF/GLB, OBJ, FBX, STL, PLY, USD. Format from the extension, `--selected` for selection-only export. Returns path, format and byte size.
- `render --animation`: render the frame range to MP4/MOV/WEBM (via Blender's bundled ffmpeg) or to a PNG sequence for any other `--out`. `--frames 1..48` and `--fps N` control the range.
- Render control flags: `--engine cycles|eevee|workbench` (EEVEE maps to the right engine name per Blender version), `--device cpu|cuda|optix|metal|hip|oneapi`, `--denoise on|off` for GPU-less and CI boxes where OpenImageDenoise is missing.
- Verifiable render results: every render now returns `engine`, `resolution`, `samples`, `frame`/`frames`, `duration_ms` and `bytes` so the agent can confirm the output without a second round-trip.
- `exec --check` / `run --check`: compile agent code and flag risky calls (shell, subprocess, network, deletes, dynamic eval) without executing anything. Syntax errors come back structured with line and message.
- `--timeout <sec>` on every command: kills a hung Blender (SIGKILL) and returns `timed_out: true` instead of hanging the agent forever.
- Agent `print()` output is captured and returned as `logs` in the JSON result; every result carries `ms` (body execution time).
- `doctor` v2: cross-platform binary discovery (macOS app bundle, `/usr/bin`, snap, flatpak, Windows `Program Files`), a version-support verdict, and a capability report: available importers/exporters, ffmpeg video support, render engines, GPU compute devices. On failure it lists every path it searched.
- `scene` now also reports the render engine and resolution.
- `version` command.

### Fixed

- `render --samples` was parsed but silently ignored; it is now wired to Cycles and EEVEE sample counts.
- A Blender binary was previously only auto-detected on macOS; Linux and Windows installs now resolve without `BLENDER_BIN`. An explicitly pinned `--blender`/`BLENDER_BIN` path now fails loudly instead of silently falling back to a different install.
- The result contract is now collision-proof: the sentinel JSON line is base64-armored, so agent output containing the delimiter strings can no longer corrupt it, and NaN/Infinity floats serialize as strings instead of breaking the parse.
- Agent code now executes verbatim from its own file; multi-line string literals are no longer re-indented (which corrupted their content in 0.0.1).
- Uniform agent contract: every command (including usage errors and `--check` on non-compiling code) emits one JSON object on stdout with `ok`, and exit code 1 exactly when `ok` is false. `scene` no longer strips the envelope on success.
- `-H`/`--human` was documented but dead; it now pretty-prints on every command.
- Renders to an extension-less or non-PNG `--out` no longer misreport: the output format follows the extension (png, jpg, exr, tif, bmp, webp), and `rendered` always points at the file actually written.
- Stale frames from a previous animation render are cleaned before re-rendering to the same output; glob metacharacters in output paths no longer break result collection.

## 0.0.1 (2026-07-03)

- First slice: `doctor`, `new`, `exec`, `run`, `scene`, `render` (headless bpy executor with sentinel JSON contract).
