# Changelog

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
