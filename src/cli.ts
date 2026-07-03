#!/usr/bin/env node
// blender-cli — Drive Blender headless from your agent: scaffold, build, animate from natural language.
// Agent-first CLI: JSON output by default, -H/--human for a table.
// The CLI is a deterministic headless executor + inspector; your agent writes the bpy.
// Built on cli-foundation (see foundation.ts for the primitives used here).

import * as fdn from './foundation.js';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, dirname } from 'node:path';

const DIR = fdn.dirOf(import.meta.url);
const env = fdn.loadEnv(`${DIR}/.env`);

// Coerce a parsed flag to a plain string (value-flags only) or undefined.
const str = (v: fdn.FlagValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

interface BlenderResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  [k: string]: unknown;
}

// --- Locate the Blender binary (macOS-first, overridable) -------------------
function blenderBin(flags: fdn.Flags = {}): string {
  const candidates = [
    str(flags.blender),
    env.BLENDER_BIN,
    process.env.BLENDER_BIN,
    '/Applications/Blender.app/Contents/MacOS/Blender',
    'blender',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === 'blender') return c;                 // rely on PATH
    if (existsSync(c)) return c;
  }
  return '/Applications/Blender.app/Contents/MacOS/Blender'; // best guess for error msg
}

// --- The deterministic boundary: run a bpy body headless, get JSON back -----
// Wraps the body so it can read PARAMS, mutate `result`, and always emits a
// single sentinel JSON line we can parse out of Blender's noisy stdout.
const SENTINEL_A = '__BLENDER_CLI__';
const SENTINEL_B = '__END__';

interface RunOpts {
  blend?: string | undefined;
  save?: string | undefined;
  params?: Record<string, unknown>;
  flags?: fdn.Flags;
}

function runBlender(body: string, { blend, save, params = {}, flags = {} }: RunOpts = {}): BlenderResult {
  const bin = blenderBin(flags);
  const dir = mkdtempSync(join(tmpdir(), 'blender-cli-'));
  const script = join(dir, 'run.py');
  if (save) params.__save__ = save;
  const wrapper = `import bpy, json, sys, traceback
def emit(obj):
    sys.stdout.write("\\n${SENTINEL_A}" + json.dumps(obj) + "${SENTINEL_B}\\n"); sys.stdout.flush()
PARAMS = json.loads(${JSON.stringify(JSON.stringify(params))})
result = {}
try:
${body.split('\n').map(l => '    ' + l).join('\n')}
    if PARAMS.get("__save__"):
        bpy.ops.wm.save_as_mainfile(filepath=PARAMS["__save__"])
        result.setdefault("saved", PARAMS["__save__"])
    emit({"ok": True, "result": result})
except Exception as e:
    emit({"ok": False, "error": str(e), "trace": traceback.format_exc()})
    sys.exit(1)
`;
  writeFileSync(script, wrapper);

  const args = ['--background'];
  if (blend) { if (!existsSync(blend)) return { ok: false, error: `blend not found: ${blend}` }; args.push(blend); }
  args.push('--python', script, '--python-exit-code', '1');

  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, error: `cannot run Blender (${bin}): ${r.error.message}`, bin };
  const out = r.stdout || '';
  const m = out.match(new RegExp(SENTINEL_A + '([\\s\\S]*?)' + SENTINEL_B));
  if (!m) return { ok: false, error: 'no result from Blender (script may have crashed before emit)', exit: r.status, stderr_tail: (r.stderr || '').slice(-800), stdout_tail: out.slice(-800), bin };
  try { return JSON.parse(m[1]!) as BlenderResult; } catch { return { ok: false, error: 'bad JSON from Blender', raw: m[1]!.slice(0, 800) }; }
}

const commands: fdn.CommandMap = {};

// `blender-cli doctor` — find Blender, confirm headless bpy works, report version.
commands.doctor = async (args) => {
  const { flags } = fdn.parseArgs(args, ['blender']);
  const bin = blenderBin(flags);
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (ver.error) { fdn.out({ ok: false, blender_bin: bin, error: `not found/executable: ${ver.error.message}`, hint: 'set BLENDER_BIN or pass --blender <path>' }); process.exit(1); }
  const versionLine = ((ver.stdout || '').split('\n')[0] ?? '').trim();
  const probe = runBlender('result["bpy_version"] = list(bpy.app.version)\nresult["build"] = bpy.app.version_string', { flags });
  fdn.out({ ok: probe.ok === true, blender_bin: bin, version: versionLine, bpy: probe.result || null, headless_ok: probe.ok === true, error: probe.error || undefined });
};

// `blender-cli exec "<bpy>"` | `blender-cli run <script.py>` — agent-authored bpy.
// The agent writes bpy; set keys on `result` and they come back as JSON.
async function execBody(body: string, args: string[]): Promise<void> {
  const { flags } = fdn.parseArgs(args, ['blend', 'save', 'blender']);
  const r = runBlender(body, { blend: str(flags.blend), save: str(flags.save), flags });
  fdn.out(r); if (!r.ok) process.exit(1);
}
commands.exec = async (args) => {
  const { positional } = fdn.parseArgs(args, ['blend', 'save', 'blender']);
  if (!positional.length) { console.error('usage: blender-cli exec "<bpy code>" [--blend f.blend] [--save out.blend]'); process.exit(1); }
  await execBody(positional.join(' '), args);
};
commands.run = async (args) => {
  const { positional } = fdn.parseArgs(args, ['blend', 'save', 'blender']);
  const file = positional[0];
  if (!file || !existsSync(file)) { console.error(`script not found: ${file}`); process.exit(1); }
  await execBody(readFileSync(file, 'utf8'), args);
};

// `blender-cli scene [--blend f.blend]` — dump scene state as JSON (the feedback loop).
commands.scene = async (args, ctx) => {
  const { flags } = fdn.parseArgs(args, ['blend', 'blender']);
  // Count animation channels version-robustly: Blender <=4.3 exposes
  // action.fcurves directly; 4.4+ (slotted actions) moves them to
  // action.layers[].strips[].channelbags[].fcurves.
  const body = `def _fcurve_count(o):
    ad = o.animation_data
    if not ad or not ad.action:
        return 0
    act = ad.action
    if hasattr(act, "fcurves"):
        return len(act.fcurves)
    n = 0
    for layer in act.layers:
        for strip in layer.strips:
            for cb in getattr(strip, "channelbags", []):
                n += len(cb.fcurves)
    return n
sc = bpy.context.scene
result["scene"] = sc.name
result["frame_range"] = [sc.frame_start, sc.frame_end, sc.frame_current]
result["fps"] = sc.render.fps
result["objects"] = [
    {"name": o.name, "type": o.type,
     "location": [round(v,4) for v in o.location],
     "rotation_euler": [round(v,4) for v in o.rotation_euler],
     "scale": [round(v,4) for v in o.scale],
     "keyframes": _fcurve_count(o)}
    for o in sc.objects]
result["materials"] = [m.name for m in bpy.data.materials]
result["cameras"] = [o.name for o in sc.objects if o.type == "CAMERA"]
result["lights"] = [o.name for o in sc.objects if o.type == "LIGHT"]`;
  const r = runBlender(body, { blend: str(flags.blend), flags });
  fdn.emit(r.ok ? r.result : r, {
    human: ctx.human,
    table: () => JSON.stringify(r.result || r, null, 2),
  });
  if (!r.ok) process.exit(1);
};

// `blender-cli render [--blend f.blend] --out preview.png [--frame N]` — preview PNG.
// `blender-cli render --anim --out clip.mp4` — render the frame range as a video (or,
// if --out has an image extension, a numbered PNG sequence). --start/--end/--fps override.
// Video encoding uses Blender's own FFmpeg when the build has it, else falls back to a
// PNG sequence + system `ffmpeg` (works on FFmpeg-less builds like some dev/CI Blenders).
const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm'];
commands.render = async (args) => {
  const { flags } = fdn.parseArgs(args, ['blend', 'out', 'frame', 'start', 'end', 'fps', 'samples', 'res', 'blender']);
  const anim = Boolean(flags.anim);
  // Resolve to an absolute path: under --background, Blender resolves a bare
  // relative filepath against its own startup dir (not our cwd) and fails to save.
  const out = resolve(str(flags.out) || (anim ? 'render.mp4' : 'preview.png'));
  const ext = extname(out).toLowerCase();
  const wantVideo = anim && VIDEO_EXTS.includes(ext);
  // Ensure the output directory exists (Blender won't create it, and it lists it
  // to detect written frames). Covers stills, sequences, and final video output.
  mkdirSync(dirname(out), { recursive: true });
  // A temp dir for the PNG sequence when we must encode video externally.
  const framesDir = wantVideo ? mkdtempSync(join(tmpdir(), 'blcli-frames-')) : null;

  const body = `import os
sc = bpy.context.scene
if not any(o.type == "CAMERA" for o in sc.objects):
    raise RuntimeError("no camera in scene to render from")
if PARAMS.get("res"):
    w,h = [int(x) for x in str(PARAMS["res"]).lower().split("x")]
    sc.render.resolution_x, sc.render.resolution_y = w, h
if PARAMS.get("fps") is not None:
    sc.render.fps = int(PARAMS["fps"])
out = PARAMS["out"]
if PARAMS.get("anim"):
    # Animation render: whole frame range (or --start/--end subrange).
    if PARAMS.get("start") is not None: sc.frame_start = int(PARAMS["start"])
    if PARAMS.get("end") is not None: sc.frame_end = int(PARAMS["end"])
    ext = os.path.splitext(out)[1].lower()
    video = {".mp4": "MPEG4", ".mov": "QUICKTIME", ".mkv": "MKV", ".webm": "WEBM"}
    is_video = ext in video
    # FFMPEG is listed in bl_rna even on builds compiled without it; only the runtime
    # assignment reveals whether this build actually supports video output.
    has_ffmpeg = False
    if is_video:
        try:
            sc.render.image_settings.file_format = "FFMPEG"
            has_ffmpeg = True
        except TypeError:
            has_ffmpeg = False
    if is_video and has_ffmpeg:
        sc.render.ffmpeg.format = video[ext]
        sc.render.ffmpeg.codec = "WEBM" if ext == ".webm" else "H264"
        sc.render.filepath = out
        sc.render.use_file_extension = False
        outdir = os.path.dirname(out) or "."
        before = set(os.listdir(outdir))
        bpy.ops.render.render(animation=True)
        after = sorted(f for f in os.listdir(outdir) if f not in before)
        result["mode"] = "video"
        result["written"] = [os.path.join(outdir, f) for f in after] if after else [out]
    elif is_video:
        # No FFmpeg in this Blender build: render a PNG sequence for external encode.
        fd = PARAMS["frames_dir"]
        sc.render.image_settings.file_format = "PNG"
        sc.render.filepath = os.path.join(fd, "frame_")
        bpy.ops.render.render(animation=True)
        result["mode"] = "video-needs-encode"
        result["frames_dir"] = fd
    else:
        # Image sequence: --out is a filename prefix; Blender appends zero-padded frame
        # numbers + extension. Strip a trailing image extension so "shot_.png" -> "shot_0001.png".
        sc.render.image_settings.file_format = "PNG"
        prefix = out
        for e in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".exr", ".bmp"):
            if prefix.lower().endswith(e):
                prefix = prefix[:-len(e)]
                break
        sc.render.filepath = prefix
        outdir = os.path.dirname(out) or "."
        before = set(os.listdir(outdir))
        bpy.ops.render.render(animation=True)
        after = sorted(f for f in os.listdir(outdir) if f not in before)
        result["mode"] = "sequence"
        result["written"] = [os.path.join(outdir, f) for f in after]
    result["frames"] = [sc.frame_start, sc.frame_end]
    result["fps"] = sc.render.fps
else:
    if PARAMS.get("frame") is not None: sc.frame_set(int(PARAMS["frame"]))
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    result["rendered"] = out`;

  const r = runBlender(body, { blend: str(flags.blend), params: {
    out, anim,
    frame: str(flags.frame) ?? null,
    start: str(flags.start) ?? null,
    end: str(flags.end) ?? null,
    fps: str(flags.fps) ?? null,
    res: str(flags.res) || null,
    frames_dir: framesDir,
  }, flags });

  // Fallback path: Blender rendered PNGs, we encode the video with system ffmpeg.
  if (r.ok && (r.result as Record<string, unknown>)?.mode === 'video-needs-encode' && framesDir) {
    const res = r.result as Record<string, unknown>;
    const fps = Number(res.fps) || 24;
    const codec = ext === '.webm'
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30']
      : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    const ff = spawnSync('ffmpeg', [
      '-y', '-framerate', String(fps),
      '-pattern_type', 'glob', '-i', join(framesDir, 'frame_*.png'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...codec, out,
    ], { encoding: 'utf8' });
    rmSync(framesDir, { recursive: true, force: true });
    if (ff.error || ff.status !== 0) {
      fdn.out({ ok: false, error: 'video encode failed', hint: ff.error
        ? 'this Blender build has no FFmpeg and no system `ffmpeg` was found on PATH — render an image sequence instead (--out frames/shot_.png)'
        : (ff.stderr || '').slice(-600) });
      process.exit(1);
    }
    delete res.frames_dir;
    res.mode = 'video';
    res.written = [out];
    res.encoder = 'system ffmpeg';
  } else if (framesDir) {
    rmSync(framesDir, { recursive: true, force: true });
  }

  fdn.out(r); if (!r.ok) process.exit(1);
};

// `blender-cli new <name> [--save path.blend]` — scaffold a clean project with camera + light.
commands.new = async (args) => {
  const { flags, positional } = fdn.parseArgs(args, ['save', 'blender']);
  const name = positional.join(' ') || 'untitled';
  const save = str(flags.save) || join(process.cwd(), `${name.replace(/\s+/g, '_')}.blend`);
  const body = `bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.name = PARAMS["name"]
# camera
cam_data = bpy.data.cameras.new("Camera"); cam = bpy.data.objects.new("Camera", cam_data)
sc.collection.objects.link(cam); sc.camera = cam
cam.location = (7.36, -6.93, 4.96); cam.rotation_euler = (1.109, 0.0, 0.815)
# key light
light_data = bpy.data.lights.new("Key", type="AREA"); light_data.energy = 1000
light = bpy.data.objects.new("Key", light_data); sc.collection.objects.link(light)
light.location = (4.0, 1.0, 6.0)
sc.render.resolution_x = 1920; sc.render.resolution_y = 1080
result["scaffolded"] = {"scene": sc.name, "camera": cam.name, "light": light.name}`;
  const r = runBlender(body, { save, params: { name }, flags });
  fdn.out(r); if (!r.ok) process.exit(1);
};

commands.help = () => {
  console.error(`blender-cli — drive Blender headless from your agent (JSON out; -H for table)

Usage: blender-cli <command> [args] [--blender <path>] [--human]

  doctor                       find Blender, confirm headless bpy works, print version   <-- run this first
  new <name> [--save f.blend]  scaffold a clean project (camera + key light + 1080p)
  exec "<bpy>"  [--blend f] [--save f]   run agent-authored bpy; set result[...] keys -> JSON back
  run <script.py> [--blend f] [--save f] same, from a .py file
  scene [--blend f]            dump objects / frame range / materials / keyframe counts as JSON
  render [--blend f] --out preview.png [--frame N] [--res 1280x720]   single still
  render --anim --out clip.mp4 [--start N] [--end N] [--fps N] [--res WxH]   animation (.mp4/.mov/.mkv/.webm = video; else PNG sequence)

Env: BLENDER_BIN overrides the binary path (default /Applications/Blender.app/Contents/MacOS/Blender).
The agent writes bpy for building/animating; the CLI just runs it deterministically and reports state.`);
};

fdn.run({ commands, help: commands.help as () => void }, process.argv.slice(2));
