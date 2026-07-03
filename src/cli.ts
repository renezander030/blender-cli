#!/usr/bin/env node
// blender-cli — Drive Blender headless from your agent: scaffold, build, animate from natural language.
// Agent-first CLI: JSON output by default, -H/--human for a table.
// The CLI is a deterministic headless executor + inspector; your agent writes the bpy.
// Built on cli-foundation (see foundation.ts for the primitives used here).

import * as fdn from './foundation.js';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
commands.render = async (args) => {
  const { flags } = fdn.parseArgs(args, ['blend', 'out', 'frame', 'samples', 'res', 'blender']);
  // Resolve to an absolute path: under --background, Blender resolves a bare
  // relative filepath against its own startup dir (not our cwd) and fails to save.
  const out = resolve(str(flags.out) || 'preview.png');
  const body = `sc = bpy.context.scene
if PARAMS.get("frame") is not None: sc.frame_set(int(PARAMS["frame"]))
if PARAMS.get("res"):
    w,h = [int(x) for x in str(PARAMS["res"]).lower().split("x")]
    sc.render.resolution_x, sc.render.resolution_y = w, h
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = PARAMS["out"]
if not any(o.type == "CAMERA" for o in sc.objects):
    raise RuntimeError("no camera in scene to render from")
bpy.ops.render.render(write_still=True)
result["rendered"] = PARAMS["out"]`;
  const r = runBlender(body, { blend: str(flags.blend), params: { out, frame: str(flags.frame) ?? null, res: str(flags.res) || null }, flags });
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
  render [--blend f] --out preview.png [--frame N] [--res 1280x720]

Env: BLENDER_BIN overrides the binary path (default /Applications/Blender.app/Contents/MacOS/Blender).
The agent writes bpy for building/animating; the CLI just runs it deterministically and reports state.`);
};

fdn.run({ commands, help: commands.help as () => void }, process.argv.slice(2));
