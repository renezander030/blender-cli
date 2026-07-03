# Timeline example

Render an animated timeline with Blender — a **flat 2D** version, or a **3D** version
with glowing marker nodes revealed by Geometry Nodes, depth-of-field, volumetric fog,
and raytraced floor reflections. Driven entirely by a small JSON file.

## Usage

```bash
# 3D timeline -> mp4
python3 render-timeline.py example.json --mode 3d --out timeline.mp4

# flat 2D timeline at 1080p
python3 render-timeline.py example.json --mode flat --res 1920x1080

# composite the timeline over a photoreal background image
python3 render-timeline.py example.json --mode 3d --bg scene.jpg
```

Requires **Blender** (default path `/Applications/Blender.app/...`, override with
`--blender <path>`) and **ffmpeg** on `PATH`. Output is a ready `.mp4`.

## Data

`example.json`:

```json
{
  "title": "THE COLLAPSE — 1250 to 1175 BC",
  "durationSec": 5,
  "events": [
    {"date": "1250 BC", "label": "Drought begins", "axisU": 0.10, "emphasize": false},
    {"date": "1200 BC", "label": "Cities burn",    "axisU": 0.50, "emphasize": false},
    {"date": "1159 BC", "label": "Hekla 3 erupts", "axisU": 0.92, "emphasize": true}
  ]
}
```

- `axisU` — 0..1 position along the timeline
- `emphasize` — highlighted "hero" marker (gold)

## How it works

The **3D** mode uses the standard Geometry-Nodes reveal pattern: one **Scene Time → Map
Range** progress drives a per-marker staggered reveal keyed off a baked `t0` attribute;
markers are glowing **nodes on a line** (so nothing occludes the labels); a **controlled
3/4 camera** keeps the whole timeline framed and readable. The **flat** mode is a clean
orthographic 2D timeline (axis draws left→right, markers pop in).

Fonts resolve from the system — a serif for the title/dates, a clean sans for the small
labels — and can be overridden with `--title-font` / `--label-font`. Video is encoded
with system `ffmpeg`, so it also works on Blender builds compiled without FFmpeg (it
falls back to a PNG sequence + external encode).
