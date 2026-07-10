#!/usr/bin/env node
// blender-cli — Drive Blender headless from your agent: scaffold, build, animate from natural language.
// Agent-first CLI: JSON output by default, -H/--human for a table.
// The CLI is a deterministic headless executor + inspector; your agent writes the bpy.
// Built on cli-foundation (see foundation.ts for the primitives used here).

import * as fdn from './foundation.js';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, dirname, basename } from 'node:path';

const DIR = fdn.dirOf(import.meta.url);
const env = fdn.loadEnv(`${DIR}/.env`);

// Coerce a parsed flag to a plain string (value-flags only) or undefined.
const str = (v: fdn.FlagValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
// "x,y,z" -> [x,y,z], defaulting missing components to 0.
const vec3 = (s: string | undefined): [number, number, number] => {
  const p = (s || '').split(',').map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
};

interface BlenderResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  [k: string]: unknown;
}

// --- Locate the Blender binary (cross-platform, overridable) ----------------
// Precedence: --blender flag > BLENDER_BIN env (matches the ordering this codebase
// already had) > platform-specific well-known install locations > `which`/`where`
// on PATH > bare "blender"/"blender.exe" (resolved by the OS at spawn time).
function whichBlender(): string | undefined {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch { /* which/where itself missing — ignore */ }
  return undefined;
}

// Windows installs versioned dirs side by side (e.g. "Blender 4.2", "Blender 5.1") —
// glob them and pick the highest version number.
function windowsBlenderCandidates(): string[] {
  const base = 'C:\\Program Files\\Blender Foundation';
  try {
    const entries = readdirSync(base).filter(e => /^Blender\s+[\d.]+/i.test(e));
    entries.sort((a, b) => {
      const va = (a.match(/[\d.]+/)?.[0] || '').split('.').map(Number);
      const vb = (b.match(/[\d.]+/)?.[0] || '').split('.').map(Number);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] || 0) - (va[i] || 0);
        if (d) return d;
      }
      return 0;
    });
    return entries.map(e => join(base, e, 'blender.exe'));
  } catch { return []; } // base dir doesn't exist on this machine
}

function linuxBlenderCandidates(): string[] {
  const home = homedir();
  return [
    '/usr/bin/blender',
    '/snap/bin/blender',
    '/var/lib/flatpak/exports/bin/org.blender.Blender',
    join(home, '.local/share/flatpak/exports/bin/org.blender.Blender'),
  ];
}

function platformCandidates(): string[] {
  const list: (string | undefined)[] = [];
  if (process.platform === 'darwin') {
    list.push('/Applications/Blender.app/Contents/MacOS/Blender', join(homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'));
  } else if (process.platform === 'win32') {
    list.push(...windowsBlenderCandidates());
  } else {
    list.push(...linuxBlenderCandidates());
  }
  list.push(whichBlender()); // PATH lookup, works on every platform
  return list.filter(Boolean) as string[];
}

// Full ordered candidate list (flag/env first), used by both blenderBin() and `doctor`.
function candidateList(flags: fdn.Flags = {}): string[] {
  return [
    str(flags.blender),
    env.BLENDER_BIN,
    process.env.BLENDER_BIN,
    ...platformCandidates(),
    process.platform === 'win32' ? 'blender.exe' : 'blender',
  ].filter(Boolean) as string[];
}

function blenderBin(flags: fdn.Flags = {}): string {
  for (const c of candidateList(flags)) {
    if (c === 'blender' || c === 'blender.exe') return c; // rely on PATH at spawn time
    if (existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'blender.exe' : '/Applications/Blender.app/Contents/MacOS/Blender'; // best guess for error msg
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
  const candidates = candidateList(flags);
  const probed = candidates.map(c => ({ path: c, exists: (c === 'blender' || c === 'blender.exe') ? null : existsSync(c) }));
  const bin = blenderBin(flags);
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (ver.error) { fdn.out({ ok: false, platform: process.platform, blender_bin: bin, probed, error: `not found/executable: ${ver.error.message}`, hint: 'set BLENDER_BIN or pass --blender <path>; none of the probed candidates resolved' }); process.exit(1); }
  const versionLine = ((ver.stdout || '').split('\n')[0] ?? '').trim();
  const probe = runBlender('result["bpy_version"] = list(bpy.app.version)\nresult["build"] = bpy.app.version_string', { flags });
  fdn.out({ ok: probe.ok === true, platform: process.platform, blender_bin: bin, probed, version: versionLine, bpy: probe.result || null, headless_ok: probe.ok === true, error: probe.error || undefined });
};

// --- opt-in exec/run sandbox: ast-validate agent-supplied Python before running it -----
// Default behavior is unchanged (no validation at all) — this is strictly opt-in via
// --safe, or made the default with BLENDER_CLI_SAFE=1 (then --unsafe overrides back to
// permissive). The validation itself runs INSIDE the generated bpy script via Python's
// `ast` module, before the user code is ever exec()'d.
function isSafeMode(flags: fdn.Flags): boolean {
  if (flags.unsafe) return false;
  if (flags.safe) return true;
  return (env.BLENDER_CLI_SAFE ?? process.env.BLENDER_CLI_SAFE) === '1';
}
// Rejects: imports of os/subprocess/socket/shutil/sys/ctypes/urllib/http; write-mode
// open()/.open() (covers pathlib's Path.open too); eval/exec/__import__; getattr()-based
// module escapes; and attribute access that looks like an os.system/pathlib-write escape
// (system, popen, rmtree, write_text, write_bytes, ...). Deliberately NOT banned:
// .remove/.unlink/.replace/.rename — everyday bpy collection + str methods
// (bpy.data.objects.remove, collection.objects.unlink, "a".replace) would false-positive;
// the import ban already keeps os/shutil out of reach. Best-effort static gate, not a jail.
const SAFE_EXEC_BODY = `import ast, sys
_src = PARAMS["__user_code__"]
BANNED_IMPORTS = {"os", "subprocess", "socket", "shutil", "sys", "ctypes", "urllib", "http"}
BANNED_CALLS = {"eval", "exec", "__import__"}
BANNED_ATTRS = {
    "system", "popen", "spawnl", "spawnv", "spawnve", "fork", "execl", "execv", "execve", "execvp", "startfile",
    "rmtree", "write_text", "write_bytes", "chmod", "symlink_to", "hardlink_to", "removedirs",
}

def _mode_is_write(node):
    kwargs = {k.arg: k.value for k in node.keywords}
    mode_node = node.args[1] if len(node.args) > 1 else kwargs.get("mode")
    if isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str):
        return any(c in mode_node.value for c in ("w", "a", "x", "+"))
    return False  # non-literal/absent mode: can't statically prove unsafe -> allow (best-effort)

violations = []
tree = None
try:
    tree = ast.parse(_src)
except SyntaxError as e:
    violations.append("syntax error: " + str(e))

if tree is not None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in BANNED_IMPORTS:
                    violations.append("import of banned module: " + alias.name)
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if top in BANNED_IMPORTS:
                violations.append("import-from banned module: " + str(node.module))
        elif isinstance(node, ast.Call):
            fname = node.func.id if isinstance(node.func, ast.Name) else (node.func.attr if isinstance(node.func, ast.Attribute) else None)
            if fname in BANNED_CALLS:
                violations.append("call to banned builtin: " + str(fname))
            if fname == "open" and _mode_is_write(node):
                violations.append("open()/.open() call in write/append mode")
            if fname == "getattr" and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id in BANNED_IMPORTS:
                violations.append("getattr() escape via banned module: " + node.args[0].id)
        elif isinstance(node, ast.Attribute):
            if node.attr in BANNED_ATTRS:
                violations.append("attribute access looks like a system/filesystem escape: ." + node.attr)

if violations:
    emit({"ok": False, "error": "sandbox: rejected " + str(len(violations)) + " violation(s)", "violations": violations})
    sys.exit(1)

exec(compile(tree, "<user_code>", "exec"))`;

// `blender-cli exec "<bpy>"` | `blender-cli run <script.py>` — agent-authored bpy.
// The agent writes bpy; set keys on `result` and they come back as JSON.
// `--safe` (or env BLENDER_CLI_SAFE=1, overridable with `--unsafe`) runs the ast gate above.
async function execBody(body: string, args: string[]): Promise<void> {
  const { flags } = fdn.parseArgs(args, ['blend', 'save', 'blender']);
  const safe = isSafeMode(flags);
  const runBody = safe ? SAFE_EXEC_BODY : body;
  const params: Record<string, unknown> = safe ? { __user_code__: body } : {};
  const r = runBlender(runBody, { blend: str(flags.blend), save: str(flags.save), params, flags });
  fdn.out(r); if (!r.ok) process.exit(1);
}
commands.exec = async (args) => {
  const { positional } = fdn.parseArgs(args, ['blend', 'save', 'blender']);
  if (!positional.length) { console.error('usage: blender-cli exec "<bpy code>" [--blend f.blend] [--save out.blend] [--safe|--unsafe]'); process.exit(1); }
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

// `blender-cli verify [--blend f.blend]` — geometry + scene sanity audit: world-space
// bounding boxes/dimensions per object, pairwise AABB overlaps among meshes, transform
// sanity (non-uniform/negative/huge scale), below-ground/floating checks, and a
// best-effort camera-frustum coverage check. The agent's "did the build actually work" loop.
commands.verify = async (args, ctx) => {
  const { flags } = fdn.parseArgs(args, ['blend', 'blender']);
  const body = `import mathutils
from bpy_extras.object_utils import world_to_camera_view

def _world_bbox(obj):
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]; ys = [c.y for c in corners]; zs = [c.z for c in corners]
    mn = (min(xs), min(ys), min(zs))
    mx = (max(xs), max(ys), max(zs))
    dims = (mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2])
    return mn, mx, dims, corners

def _overlap(amn, amx, bmn, bmx):
    return all(amn[i] <= bmx[i] and bmn[i] <= amx[i] for i in range(3))

scene = bpy.context.scene
EPS = 1e-4
SCALE_HUGE = 50.0
SCALE_TOL = 1e-3

objs = list(scene.objects)
mesh_objs = [o for o in objs if o.type == "MESH"]

obj_info = {}
for o in objs:
    mn, mx, dims, _ = _world_bbox(o)
    obj_info[o.name] = {
        "name": o.name, "type": o.type,
        "bbox_min": [round(v, 4) for v in mn],
        "bbox_max": [round(v, 4) for v in mx],
        "dimensions": [round(v, 4) for v in dims],
        "location": [round(v, 4) for v in o.location],
        "scale": [round(v, 4) for v in o.scale],
    }

issues = []

# (a) pairwise AABB overlap among mesh objects
for i in range(len(mesh_objs)):
    for j in range(i + 1, len(mesh_objs)):
        a, b = mesh_objs[i], mesh_objs[j]
        amn, amx = obj_info[a.name]["bbox_min"], obj_info[a.name]["bbox_max"]
        bmn, bmx = obj_info[b.name]["bbox_min"], obj_info[b.name]["bbox_max"]
        if _overlap(amn, amx, bmn, bmx):
            issues.append({"type": "aabb_overlap", "objects": [a.name, b.name], "detail": "world-space bounding boxes overlap"})

# (b) transform sanity: non-uniform scale, negative scale, huge (likely unapplied) scale
for o in objs:
    sx, sy, sz = o.scale
    if min(sx, sy, sz) < 0:
        issues.append({"type": "negative_scale", "objects": [o.name], "detail": "scale=(%.3f,%.3f,%.3f)" % (sx, sy, sz)})
    if max(abs(sx - sy), abs(sy - sz), abs(sx - sz)) > SCALE_TOL:
        issues.append({"type": "non_uniform_scale", "objects": [o.name], "detail": "scale=(%.3f,%.3f,%.3f)" % (sx, sy, sz)})
    if max(abs(sx), abs(sy), abs(sz)) > SCALE_HUGE:
        issues.append({"type": "huge_scale", "objects": [o.name], "detail": "scale=(%.3f,%.3f,%.3f) exceeds %.0f - likely unapplied" % (sx, sy, sz, SCALE_HUGE)})

# (c) below ground (z<0) / floating far from the rest of the scene
centers = {}
for o in mesh_objs:
    mn = obj_info[o.name]["bbox_min"]; mx = obj_info[o.name]["bbox_max"]
    centers[o.name] = [(mn[k] + mx[k]) / 2.0 for k in range(3)]

if mesh_objs:
    all_mn = [min(obj_info[o.name]["bbox_min"][k] for o in mesh_objs) for k in range(3)]
    all_mx = [max(obj_info[o.name]["bbox_max"][k] for o in mesh_objs) for k in range(3)]
    scene_diag = sum((all_mx[k] - all_mn[k]) ** 2 for k in range(3)) ** 0.5
    scene_centroid = [(all_mn[k] + all_mx[k]) / 2.0 for k in range(3)]
else:
    scene_diag = 0.0
    scene_centroid = [0.0, 0.0, 0.0]

for o in mesh_objs:
    mn = obj_info[o.name]["bbox_min"]
    if mn[2] < -EPS:
        issues.append({"type": "below_ground", "objects": [o.name], "detail": "bbox min z=%.4f < 0" % mn[2]})
    c = centers[o.name]
    dist = sum((c[k] - scene_centroid[k]) ** 2 for k in range(3)) ** 0.5
    if scene_diag > EPS and len(mesh_objs) > 1 and dist > max(scene_diag * 3.0, 10.0):
        issues.append({"type": "floating_far", "objects": [o.name], "detail": "center is %.2f units from scene centroid (scene diag %.2f)" % (dist, scene_diag)})

# (d) camera exists + best-effort frustum coverage per mesh
cams = [o for o in objs if o.type == "CAMERA"]
cam = scene.camera or (cams[0] if cams else None)
if not cams:
    issues.append({"type": "no_camera", "objects": [], "detail": "scene has no camera object"})
else:
    for o in mesh_objs:
        corners = _world_bbox(o)[3]
        any_in = False
        all_in = True
        for c in corners:
            ndc = world_to_camera_view(scene, cam, c)
            inside = 0.0 <= ndc.x <= 1.0 and 0.0 <= ndc.y <= 1.0 and ndc.z > 0.0
            any_in = any_in or inside
            all_in = all_in and inside
        obj_info[o.name]["in_camera_view"] = "full" if all_in else ("partial" if any_in else "none")
        if not any_in:
            issues.append({"type": "outside_camera_view", "objects": [o.name], "detail": "no bbox corner projects inside camera frustum"})

# (e) counts summary
result["objects"] = list(obj_info.values())
result["issues"] = issues
result["summary"] = {
    "object_count": len(objs),
    "mesh_count": len(mesh_objs),
    "camera_count": len(cams),
    "overlap_count": len([i for i in issues if i["type"] == "aabb_overlap"]),
    "issue_count": len(issues),
}`;
  const r = runBlender(body, { blend: str(flags.blend), flags });
  // Agent contract: {ok, objects, issues, summary} in one flat object.
  fdn.emit(r.ok ? { ok: true, ...r.result } : r, {
    human: ctx.human,
    table: () => JSON.stringify(r.ok ? r.result : r, null, 2),
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

// --- asset import: local files (.obj/.glb/.gltf/.fbx/.stl/.ply) + Poly Haven ------
// bpy body shared by local-file import and Poly Haven model import: probes bpy.ops
// for the format's importer (Blender 4.x+ moved several to wm.*_import; this checks
// what's actually registered instead of hard-coding one API generation).
function localImportBody(): string {
  return `import os
before = set(o.name for o in bpy.data.objects)
p = PARAMS["path"]
ext = os.path.splitext(p)[1].lower()
if ext == ".obj":
    if hasattr(bpy.ops.wm, "obj_import"):
        bpy.ops.wm.obj_import(filepath=p)
    else:
        bpy.ops.import_scene.obj(filepath=p)
elif ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=p)
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=p)
elif ext == ".stl":
    if hasattr(bpy.ops.wm, "stl_import"):
        bpy.ops.wm.stl_import(filepath=p)
    else:
        bpy.ops.import_mesh.stl(filepath=p)
elif ext == ".ply":
    if hasattr(bpy.ops.wm, "ply_import"):
        bpy.ops.wm.ply_import(filepath=p)
    else:
        bpy.ops.import_mesh.ply(filepath=p)
else:
    raise RuntimeError("unsupported import extension: " + ext)
after = set(o.name for o in bpy.data.objects)
result["imported_objects"] = sorted(after - before)
result["object_count"] = len(bpy.data.objects)`;
}

const POLYHAVEN_CACHE = join(homedir(), '.cache', 'blender-cli', 'polyhaven');
const POLYHAVEN_TYPE_NAMES: Record<number, string> = { 0: 'hdri', 1: 'texture', 2: 'model' };
// map names that are full-asset formats, not texture maps — skip when flattening a texture import
const POLYHAVEN_NON_MAP_KEYS = new Set(['blend', 'gltf', 'usd', 'fbx', 'mtlx']);

async function downloadTo(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed (${r.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

interface PolyHavenResult {
  ok: true;
  assetType: string;
  kind: 'hdri' | 'texture' | 'model';
  path?: string;          // primary local file (hdri image, or model .gltf)
  maps?: Record<string, string>; // texture: map name -> local file
}
interface PolyHavenError { ok: false; error: string }

// Downloads a Poly Haven asset's files at a given resolution into ~/.cache/blender-cli/polyhaven/.
// Keyless public API (api.polyhaven.com for metadata, dl.polyhaven.org for the actual bytes).
async function polyHavenDownload(assetId: string, typeHint: string | undefined, res: string): Promise<PolyHavenResult | PolyHavenError> {
  try {
    const infoRes = await fetch(`https://api.polyhaven.com/info/${assetId}`);
    if (!infoRes.ok) return { ok: false, error: `polyhaven info ${assetId}: HTTP ${infoRes.status} (unknown asset id?)` };
    const info = await infoRes.json() as { type?: number };
    const assetType = typeHint || (info.type !== undefined ? POLYHAVEN_TYPE_NAMES[info.type] : undefined) || 'texture';

    const filesRes = await fetch(`https://api.polyhaven.com/files/${assetId}`);
    if (!filesRes.ok) return { ok: false, error: `polyhaven files ${assetId}: HTTP ${filesRes.status}` };
    const files = await filesRes.json() as Record<string, any>;
    const outDir = join(POLYHAVEN_CACHE, assetId, res);

    if (assetType === 'hdri') {
      const atRes = files.hdri?.[res];
      if (!atRes) return { ok: false, error: `no hdri at resolution ${res} for ${assetId} (available: ${Object.keys(files.hdri || {}).join(', ')})` };
      const fmt = atRes.hdr || atRes.exr;
      if (!fmt) return { ok: false, error: `no hdr/exr file for ${assetId}@${res}` };
      const dest = join(outDir, basename(new URL(fmt.url).pathname));
      await downloadTo(fmt.url, dest);
      return { ok: true, assetType, kind: 'hdri', path: dest };
    }

    if (assetType === 'model') {
      const atRes = files.gltf?.[res];
      if (!atRes?.gltf) return { ok: false, error: `no gltf package at resolution ${res} for ${assetId} (available: ${Object.keys(files.gltf || {}).join(', ')})` };
      const main = atRes.gltf;
      const mainDest = join(outDir, basename(new URL(main.url).pathname));
      await downloadTo(main.url, mainDest);
      const include = (main.include || {}) as Record<string, { url: string }>;
      for (const relPath of Object.keys(include)) {
        await downloadTo(include[relPath]!.url, join(outDir, relPath));
      }
      return { ok: true, assetType, kind: 'model', path: mainDest };
    }

    // texture: every top-level key that isn't a full-asset package is a map (Diffuse, nor_gl, Rough, AO, ...)
    const maps: Record<string, string> = {};
    for (const mapName of Object.keys(files)) {
      if (POLYHAVEN_NON_MAP_KEYS.has(mapName)) continue;
      const atRes = files[mapName]?.[res];
      if (!atRes) continue;
      const fmt = atRes.jpg || atRes.png || atRes.exr;
      if (!fmt) continue;
      const dest = join(outDir, basename(new URL(fmt.url).pathname));
      await downloadTo(fmt.url, dest);
      maps[mapName] = dest;
    }
    if (!Object.keys(maps).length) return { ok: false, error: `no texture maps at resolution ${res} for ${assetId}` };
    return { ok: true, assetType, kind: 'texture', maps };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// bpy body: set a downloaded HDRI as the world environment texture.
const HDRI_IMPORT_BODY = `world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
nt = world.node_tree
nt.nodes.clear()
bg = nt.nodes.new("ShaderNodeBackground")
env = nt.nodes.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(PARAMS["path"])
out = nt.nodes.new("ShaderNodeOutputWorld")
nt.links.new(env.outputs["Color"], bg.inputs["Color"])
nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
result["world"] = world.name
result["hdri_image"] = env.image.name`;

// bpy body: build a Principled-BSDF material from downloaded Poly Haven texture maps.
const TEXTURE_IMPORT_BODY = `mat = bpy.data.materials.new(PARAMS["material_name"])
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get("Principled BSDF")
mapping = {
    "Diffuse": ("Base Color", "sRGB"), "diff": ("Base Color", "sRGB"), "diffuse": ("Base Color", "sRGB"),
    "Rough": ("Roughness", "Non-Color"), "rough": ("Roughness", "Non-Color"),
    "Metal": ("Metallic", "Non-Color"), "metal": ("Metallic", "Non-Color"),
    "nor_gl": ("Normal", "Non-Color"), "nor_dx": ("Normal", "Non-Color"), "normal": ("Normal", "Non-Color"),
    "Displacement": (None, "Non-Color"), "disp": (None, "Non-Color"),
    "AO": (None, "Non-Color"), "arm": (None, "Non-Color"), "Opacity": ("Alpha", "Non-Color"),
}
x = -400
added = []
for name, path in PARAMS["maps"].items():
    target, cs = mapping.get(name, (None, "Non-Color"))
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(path)
    node.image.colorspace_settings.name = cs
    node.location = (x, 300); x -= 300
    added.append(name)
    if target == "Normal":
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(node.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    elif target and bsdf:
        nt.links.new(node.outputs["Color"], bsdf.inputs[target])
result["material"] = mat.name
result["maps_added"] = added`;

// `blender-cli import <path-or-source> [--blend f] [--save f] [--type texture|model|hdri] [--res 1k|2k|4k]`
// Local files (.obj/.glb/.gltf/.fbx/.stl/.ply) import directly. `polyhaven:<asset-id>`
// fetches from the free, keyless Poly Haven API and imports (model), sets world env
// (hdri), or builds a material (texture).
commands.import = async (args, ctx) => {
  const { flags, positional } = fdn.parseArgs(args, ['blend', 'save', 'blender', 'type', 'res']);
  const source = positional.join(' ');
  if (!source) { console.error('usage: blender-cli import <path-or-source> [--blend f] [--save f] [--type texture|model|hdri] [--res 1k|2k|4k]'); process.exit(1); return; }

  if (source.startsWith('polyhaven:')) {
    const assetId = source.slice('polyhaven:'.length);
    const res = str(flags.res) || '1k';
    const dl = await polyHavenDownload(assetId, str(flags.type), res);
    if (!dl.ok) { fdn.out({ ok: false, error: dl.error, hint: 'check the Poly Haven asset id (see https://polyhaven.com), --type texture|model|hdri, and --res' }); process.exit(1); return; }
    let r: BlenderResult;
    if (dl.kind === 'hdri') {
      r = runBlender(HDRI_IMPORT_BODY, { blend: str(flags.blend), save: str(flags.save), params: { path: dl.path }, flags });
    } else if (dl.kind === 'model') {
      r = runBlender(localImportBody(), { blend: str(flags.blend), save: str(flags.save), params: { path: dl.path }, flags });
    } else {
      r = runBlender(TEXTURE_IMPORT_BODY, { blend: str(flags.blend), save: str(flags.save), params: { material_name: assetId, maps: dl.maps }, flags });
    }
    fdn.out({ ...r, asset_id: assetId, asset_type: dl.assetType, resolution: res });
    if (!r.ok) process.exit(1);
    return;
  }

  const path = resolve(source);
  if (!existsSync(path)) { fdn.out({ ok: false, error: `file not found: ${path}` }); process.exit(1); return; }
  const r = runBlender(localImportBody(), { blend: str(flags.blend), save: str(flags.save), params: { path }, flags });
  fdn.out(r); if (!r.ok) process.exit(1);
};

// --- text-to-3d generation: pluggable backend registry -----------------------------
// Each backend takes a prompt + output path and returns a local .glb path (downloaded)
// or a clean {ok:false} error. Add a new backend (Rodin, Hunyuan/ai3d, ...) by adding a
// key here — no other code needs to change.
interface GenerateOk { ok: true; glbPath: string; meta?: Record<string, unknown> }
interface GenerateErr { ok: false; error: string; hint?: string }
type GenerateBackend = (prompt: string, opts: { out: string }) => Promise<GenerateOk | GenerateErr>;

async function meshyGenerate(prompt: string, { out }: { out: string }): Promise<GenerateOk | GenerateErr> {
  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) return { ok: false, error: 'MESHY_API_KEY not set', hint: 'export MESHY_API_KEY=<key from https://www.meshy.ai> and retry' };
  try {
    const submit = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'preview', prompt, art_style: 'realistic', should_remesh: true }),
    });
    if (!submit.ok) return { ok: false, error: `meshy submit failed: HTTP ${submit.status}: ${(await submit.text()).slice(0, 300)}` };
    const submitJson = await submit.json() as { result: string };
    const taskId = submitJson.result;

    const deadline = Date.now() + 5 * 60 * 1000; // Meshy preview tasks typically finish in ~1-2min
    let task: Record<string, any> | null = null;
    while (Date.now() < deadline) {
      const poll = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!poll.ok) return { ok: false, error: `meshy poll failed: HTTP ${poll.status}` };
      task = await poll.json() as Record<string, any>;
      if (task.status === 'SUCCEEDED' || task.status === 'FAILED' || task.status === 'CANCELED') break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!task || task.status !== 'SUCCEEDED') {
      return { ok: false, error: `meshy task did not succeed: ${task?.status ?? 'timeout'}${task?.task_error?.message ? ' - ' + task.task_error.message : ''}` };
    }
    const glbUrl = task.model_urls?.glb;
    if (!glbUrl) return { ok: false, error: 'meshy task succeeded but no glb url in response' };
    await downloadTo(glbUrl, out);
    return { ok: true, glbPath: out, meta: { taskId, status: task.status } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const generateBackends: Record<string, GenerateBackend> = { meshy: meshyGenerate };

// `blender-cli generate "<prompt>" --out asset.glb [--import] [--backend meshy]`
// Text-to-3D via a pluggable backend (default: Meshy, needs MESHY_API_KEY). --import
// chains into the same local-file import logic used by `import`.
commands.generate = async (args) => {
  const { flags, positional } = fdn.parseArgs(args, ['out', 'backend', 'blend', 'save', 'blender']);
  const prompt = positional.join(' ');
  if (!prompt) { console.error('usage: blender-cli generate "<prompt>" --out asset.glb [--import] [--backend meshy] [--blend f] [--save f]'); process.exit(1); return; }
  const backendName = str(flags.backend) || 'meshy';
  const backend = generateBackends[backendName];
  if (!backend) { fdn.out({ ok: false, error: `unknown backend: ${backendName}`, hint: `available: ${Object.keys(generateBackends).join(', ')}` }); process.exit(1); return; }

  const out = resolve(str(flags.out) || `${prompt.replace(/\W+/g, '_').slice(0, 40) || 'generated'}.glb`);
  const gen = await backend(prompt, { out });
  if (!gen.ok) { fdn.out({ ok: false, error: gen.error, hint: gen.hint, backend: backendName }); process.exit(1); return; }

  if (flags.import) {
    const r = runBlender(localImportBody(), { blend: str(flags.blend), save: str(flags.save), params: { path: gen.glbPath }, flags });
    fdn.out({ ...r, generated: gen.glbPath, backend: backendName });
    if (!r.ok) process.exit(1);
    return;
  }
  fdn.out({ ok: true, generated: gen.glbPath, backend: backendName, meta: gen.meta });
};

// --- parametric verbs: stable high-level ops that survive bpy API drift across versions ---
// One bpy body handles both a single `add <what>` call and a `--json '[...]'` batch — a
// single-op call is just a batch of length 1, all executed in one Blender launch.
const ADD_BATCH_BODY = `import mathutils

def _add_primitive(op):
    what = op.get("what")
    name = op.get("name")
    at = tuple(op.get("at", [0, 0, 0]))
    size = float(op.get("size", 2.0))
    if what == "cube":
        bpy.ops.mesh.primitive_cube_add(size=size, location=at)
    elif what == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2.0, location=at)
    elif what == "plane":
        bpy.ops.mesh.primitive_plane_add(size=size, location=at)
    elif what == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=size / 2.0, depth=size, location=at)
    elif what == "cone":
        bpy.ops.mesh.primitive_cone_add(radius1=size / 2.0, depth=size, location=at)
    elif what == "torus":
        bpy.ops.mesh.primitive_torus_add(major_radius=size / 2.0, minor_radius=size / 8.0, location=at)
    elif what == "camera":
        bpy.ops.object.camera_add(location=at)
        obj = bpy.context.active_object
        look_at = op.get("lookAt")
        if look_at:
            direction = mathutils.Vector(look_at) - mathutils.Vector(at)
            if direction.length > 0:
                obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        if not bpy.context.scene.camera:
            bpy.context.scene.camera = obj
    elif what == "light":
        ltype = str(op.get("lightType") or op.get("type") or "POINT").upper()
        bpy.ops.object.light_add(type=ltype, location=at)
        obj = bpy.context.active_object
        if op.get("energy") is not None:
            obj.data.energy = float(op["energy"])
    else:
        raise RuntimeError("unknown 'what': " + str(what))
    obj = bpy.context.active_object
    if name:
        obj.name = name
    return obj.name

created = [_add_primitive(op) for op in PARAMS["ops"]]
result["created"] = created
result["object_count"] = len(bpy.data.objects)
result["mesh_count"] = len([o for o in bpy.data.objects if o.type == "MESH"])`;

// `blender-cli add cube|sphere|plane|cylinder|cone|torus [--size N] [--at x,y,z] [--name NAME]`
// `blender-cli add camera [--at x,y,z] [--look-at x,y,z]`
// `blender-cli add light [--type sun|point|area] [--energy N] [--at x,y,z]`
// `blender-cli add --json '[{"what":"cube","size":2}, {"what":"camera","at":[0,-5,2],"lookAt":[0,0,0]}]'`
//   — a batch of ops, all executed in a single Blender launch.
commands.add = async (args) => {
  const { flags, positional } = fdn.parseArgs(args, ['blend', 'save', 'blender', 'size', 'at', 'name', 'type', 'energy', 'look-at', 'json']);
  let ops: Record<string, unknown>[];
  if (flags.json) {
    try {
      const parsed = JSON.parse(str(flags.json) || '[]');
      if (!Array.isArray(parsed)) throw new Error('--json must be a JSON array of ops');
      ops = parsed;
    } catch (e) { fdn.out({ ok: false, error: `bad --json: ${(e as Error).message}` }); process.exit(1); return; }
  } else {
    const what = positional[0];
    if (!what) { console.error('usage: blender-cli add cube|sphere|plane|cylinder|cone|torus|camera|light [--size N] [--at x,y,z] [--name NAME] [--type sun|point|area] [--energy N] [--look-at x,y,z]\n   or: blender-cli add --json \'[{"what":"cube",...}, ...]\''); process.exit(1); return; }
    const op: Record<string, unknown> = { what };
    if (flags.size) op.size = Number(flags.size);
    if (flags.at) op.at = vec3(str(flags.at));
    if (flags.name) op.name = str(flags.name);
    if (flags.type) op.lightType = str(flags.type);
    if (flags.energy) op.energy = Number(flags.energy);
    if (flags['look-at']) op.lookAt = vec3(str(flags['look-at']));
    ops = [op];
  }
  const r = runBlender(ADD_BATCH_BODY, { blend: str(flags.blend), save: str(flags.save), params: { ops }, flags });
  fdn.out(r); if (!r.ok) process.exit(1);
};

// `blender-cli keyframe <object> --prop location|rotation|scale --frame N --value x,y,z [--blend f] [--save f]`
commands.keyframe = async (args) => {
  const { flags, positional } = fdn.parseArgs(args, ['blend', 'save', 'blender', 'prop', 'frame', 'value']);
  const name = positional.join(' ');
  const prop = str(flags.prop);
  const frame = str(flags.frame);
  const value = str(flags.value);
  if (!name || !prop || frame === undefined || !value) {
    console.error('usage: blender-cli keyframe <object> --prop location|rotation|scale --frame N --value x,y,z [--blend f] [--save f]');
    process.exit(1); return;
  }
  const body = `PROP_MAP = {"location": "location", "rotation": "rotation_euler", "scale": "scale"}
name = PARAMS["name"]
prop = PARAMS["prop"]
if prop not in PROP_MAP:
    raise RuntimeError("unknown --prop: " + str(prop) + " (use location|rotation|scale)")
data_path = PROP_MAP[prop]
obj = bpy.data.objects.get(name)
if obj is None:
    raise RuntimeError("object not found: " + name)
frame = int(PARAMS["frame"])
value = tuple(PARAMS["value"])
bpy.context.scene.frame_set(frame)
setattr(obj, data_path, value)
obj.keyframe_insert(data_path=data_path, frame=frame)

def _fcurve_count(o):
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

result["object"] = obj.name
result["frame"] = frame
result["property"] = data_path
result["keyframes"] = _fcurve_count(obj)`;
  const r = runBlender(body, { blend: str(flags.blend), save: str(flags.save), params: { name, prop, frame: Number(frame), value: vec3(value) }, flags });
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
  verify [--blend f]           geometry audit: bboxes, overlaps, transform sanity, camera coverage
  import <path|polyhaven:id> [--blend f] [--save f] [--type texture|model|hdri] [--res 1k|2k|4k]
                                import .obj/.glb/.gltf/.fbx/.stl/.ply, or fetch+import from Poly Haven
  generate "<prompt>" --out asset.glb [--import] [--backend meshy]
                                text-to-3D via a pluggable backend (default meshy, needs MESHY_API_KEY)
  add cube|sphere|plane|cylinder|cone|torus [--size N] [--at x,y,z] [--name NAME]
  add camera [--at x,y,z] [--look-at x,y,z]
  add light [--type sun|point|area] [--energy N] [--at x,y,z]
  add --json '[{"what":"cube","size":2}, ...]'   batch of ops in one Blender launch
  keyframe <object> --prop location|rotation|scale --frame N --value x,y,z
  render [--blend f] --out preview.png [--frame N] [--res 1280x720]   single still
  render --anim --out clip.mp4 [--start N] [--end N] [--fps N] [--res WxH]   animation (.mp4/.mov/.mkv/.webm = video; else PNG sequence)

Env: BLENDER_BIN overrides the binary path (default /Applications/Blender.app/Contents/MacOS/Blender).
The agent writes bpy for building/animating; the CLI just runs it deterministically and reports state.`);
};

fdn.run({ commands, help: commands.help as () => void }, process.argv.slice(2));
