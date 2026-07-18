# Changelog

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
