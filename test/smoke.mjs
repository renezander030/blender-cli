#!/usr/bin/env node
// End-to-end smoke suite. Every check shells out to the real CLI against a real
// Blender and asserts on the JSON contract — no mocking of the boundary, since
// the boundary (bpy operator names, engine identifiers, exporter behaviour) is
// exactly what drifts between Blender versions.
//
//   node test/smoke.mjs                      # whatever `blender` resolves to
//   node test/smoke.mjs --blender /path/to/blender
//
// Exits non-zero if any check fails. This is what backs the TESTED_VERSIONS
// matrix in the CLI: a version is only listed there once this suite passes on it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'blender-cli');
const argv = process.argv.slice(2);
const bi = argv.indexOf('--blender');
const BLENDER = bi !== -1 ? argv[bi + 1] : null;
const WORK = mkdtempSync(join(tmpdir(), 'bcli-smoke-'));

let pass = 0, fail = 0;
const failures = [];

// Detached jobs land in a throwaway directory so the suite never touches the
// real ~/.cache/blender-cli/jobs of whoever runs it.
const JOBS = join(WORK, 'jobs');

function cli(args, { timeout = 180000, env = null } = {}) {
  const full = BLENDER ? [...args, '--blender', BLENDER] : args;
  const r = spawnSync(process.execPath, [CLI, ...full], {
    encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, cwd: WORK,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BLENDER_CLI_JOBS_DIR: JOBS, ...(env || {}) },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* non-JSON is itself a failure the check will catch */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function check(name, fn) {
  let out;
  try {
    out = fn();
    if (out === true || out === undefined) { pass++; console.log(`  ok    ${name}`); return; }
    fail++; failures.push(`${name}: ${out}`); console.log(`  FAIL  ${name} — ${out}`);
  } catch (e) {
    fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL  ${name} — ${e.message}`);
  }
}

console.log(`blender-cli smoke — ${BLENDER || 'default blender'}\n  workdir ${WORK}\n`);

// --- the CLI itself parses ---------------------------------------------------
// The bpy bodies are template literals, so a stray backtick in a Python comment
// is a JS syntax error that turns every check below into an identical failure.
// Catch it here and say what it actually is.
{
  const r = cli(['version'], { timeout: 20000 });
  if (!r.json?.version) {
    console.log(`  FAIL  blender-cli does not parse\n${(r.stderr || r.stdout).split('\n').slice(0, 4).map(l => `        ${l}`).join('\n')}`);
    console.log('\n0 passed, 1 failed — the CLI could not be loaded, so nothing else ran.');
    rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
  }
  pass++; console.log('  ok    blender-cli parses and reports its version');
}

// --- discovery ---------------------------------------------------------------
let blenderVersion = null;
check('doctor reports a working headless bpy', () => {
  const r = cli(['doctor']);
  if (!r.json?.ok) return `doctor not ok: ${r.json?.error || r.stderr.slice(-200)}`;
  blenderVersion = (r.json.bpy_version || []).slice(0, 2).join('.');
  if (!r.json.support) return 'no support verdict';
  if (!Array.isArray(r.json.tested_versions)) return 'no tested_versions in output';
  return true;
});

check('support verdict never claims support for an untested version', () => {
  const r = cli(['doctor']);
  const { support, tested_versions } = r.json || {};
  const tested = tested_versions?.includes(blenderVersion);
  if (tested && !support.startsWith('tested')) return `${blenderVersion} is in the matrix but verdict is "${support}"`;
  if (!tested && !/^untested|^unsupported/.test(support)) return `${blenderVersion} is NOT in the matrix but verdict is "${support}"`;
  return true;
});

// --- scaffold + exec ---------------------------------------------------------
const BLEND = join(WORK, 'smoke.blend');
check('new scaffolds a project with camera and light', () => {
  const r = cli(['new', 'smoke', '--save', BLEND]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  if (!existsSync(BLEND)) return 'no .blend written';
  const s = r.json.result?.scaffolded;
  return (s?.camera && s?.light) ? true : 'scaffold missing camera/light';
});

check('exec runs agent bpy and returns result keys', () => {
  const r = cli(['exec', 'bpy.ops.mesh.primitive_cube_add(location=(0,0,0))\nresult["n"] = len(bpy.context.scene.objects)',
    '--blend', BLEND, '--save', BLEND]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  return typeof r.json.result?.n === 'number' ? true : 'result key not returned';
});

check('exec captures print() as logs', () => {
  const r = cli(['exec', 'print("hello-from-bpy")', '--blend', BLEND]);
  return r.json?.logs?.includes('hello-from-bpy') ? true : 'logs not captured';
});

check('exec --check rejects code that does not compile (exit 1)', () => {
  const r = cli(['exec', 'this is not python(', '--check']);
  if (r.code === 0) return 'exited 0 on non-compiling code';
  return r.json?.result?.compiles === false ? true : 'compiles flag not false';
});

check('exec --safe refuses a banned import (exit 1)', () => {
  const r = cli(['exec', 'import os\nos.system("echo pwned")', '--safe']);
  if (r.code === 0) return 'exited 0 on banned import';
  return r.json?.result?.violations?.length ? true : 'no violations reported';
});

check('scene dumps objects, engine and frame range', () => {
  const r = cli(['scene', '--blend', BLEND]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const s = r.json.result;
  if (!Array.isArray(s?.objects) || !s.objects.length) return 'no objects';
  if (!s.engine) return 'no engine';
  return Array.isArray(s.frame_range) ? true : 'no frame_range';
});

// --- render: the engine-identifier drift this release fixes -------------------
for (const engine of ['eevee', 'cycles', 'workbench']) {
  check(`render --engine ${engine} resolves on this build`, () => {
    const out = join(WORK, `r_${engine}.png`);
    const r = cli(['render', '--blend', BLEND, '--out', out, '--engine', engine, '--samples', '4', '--res', '96x72']);
    if (!r.json?.ok) return r.json?.error || 'not ok';
    if (!existsSync(out)) return 'no image written';
    return r.json.result?.engine ? true : 'no engine in result metadata';
  });
}

check('cycles survives a build with no OpenImageDenoise', () => {
  // Distro Blender packages ship Cycles without OIDN; denoising is on by
  // default and the render then dies. The CLI must stand down from the default
  // on its own, and say so, rather than surfacing "Failed to denoise".
  const d = cli(['doctor']).json || {};
  const out = join(WORK, 'denoise.png');
  const r = cli(['render', '--blend', BLEND, '--out', out, '--engine', 'cycles', '--samples', '4', '--res', '96x72']);
  if (!r.json?.ok) return `cycles render failed: ${r.json?.error}`;
  if (!d.cycles_denoiser && !/^off \(auto/.test(r.json.result?.denoise || '')) {
    return 'no denoiser in this build but the CLI did not report standing down';
  }
  return true;
});

check('explicit --denoise on fails loudly when unsupported', () => {
  const d = cli(['doctor']).json || {};
  const r = cli(['render', '--blend', BLEND, '--out', join(WORK, 'dn2.png'),
    '--engine', 'cycles', '--samples', '4', '--res', '96x72', '--denoise', 'on']);
  if (d.cycles_denoiser) return r.json?.ok ? true : `denoiser present but render failed: ${r.json?.error}`;
  if (r.code === 0) return 'silently ignored an impossible --denoise on';
  return /no denoiser/.test(r.json?.error || '') ? true : `unclear error: ${r.json?.error}`;
});

check('render reports resolution and byte size metadata', () => {
  const out = join(WORK, 'meta.png');
  const r = cli(['render', '--blend', BLEND, '--out', out, '--engine', 'eevee', '--samples', '4', '--res', '96x72']);
  const m = r.json?.result;
  if (!m) return 'no result';
  if (JSON.stringify(m.resolution) !== JSON.stringify([96, 72])) return `resolution ${JSON.stringify(m.resolution)} != [96,72]`;
  return m.bytes > 0 ? true : 'no byte size';
});

check('render --animation writes a PNG sequence', () => {
  const outDir = join(WORK, 'seq');
  const r = cli(['render', '--blend', BLEND, '--out', outDir, '--animation', '--frames', '1..3',
    '--engine', 'eevee', '--samples', '4', '--res', '96x72']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  return r.json.result?.frame_files === 3 ? true : `expected 3 frames, got ${r.json.result?.frame_files}`;
});

// --- export fidelity ---------------------------------------------------------
check('export glb reports a passing fidelity census', () => {
  const out = join(WORK, 'out.glb');
  const r = cli(['export', out, '--blend', BLEND]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const f = r.json.result?.exported?.fidelity;
  if (!f?.checked) return `fidelity not checked: ${f?.reason || 'no fidelity block'}`;
  if (!f.ok) return `fidelity degraded: ${JSON.stringify(f.lost)}`;
  if (!f.compared?.includes('verts')) return 'verts not compared';
  return true;
});

check('export stl is not accused of losing materials it cannot carry', () => {
  const out = join(WORK, 'out.stl');
  const r = cli(['export', out, '--blend', BLEND]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const f = r.json.result?.exported?.fidelity;
  if (!f?.checked) return `fidelity not checked: ${f?.reason}`;
  if (f.compared.includes('materials')) return 'stl compared on materials';
  return f.ok ? true : `fidelity degraded: ${JSON.stringify(f.lost)}`;
});

check('multi-object stl/ply are not flagged for merging, which they always do', () => {
  // Both formats are single triangle soups: every object collapses into one
  // mesh by definition. Counting meshes there would cry wolf on every export.
  const two = join(WORK, 'two.blend');
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\n' +
    'bpy.ops.mesh.primitive_cube_add(location=(0,0,0))\nbpy.ops.mesh.primitive_cube_add(location=(5,0,0))', '--save', two]);
  for (const ext of ['stl', 'ply']) {
    const r = cli(['export', join(WORK, `multi.${ext}`), '--blend', two]);
    const f = r.json?.result?.exported?.fidelity;
    if (!f?.checked) return `${ext}: fidelity not checked: ${f?.reason}`;
    if (f.compared.includes('meshes')) return `${ext} compared on mesh count, which it always merges`;
    if (!f.ok) return `${ext} falsely degraded: ${JSON.stringify(f.lost)}`;
  }
  return true;
});

check('fidelity still catches a genuine geometry loss', () => {
  // A mesh whose vertices are not part of any face: triangle-soup formats drop
  // them entirely. If the census cannot see this, it is not earning its keep.
  const loose = join(WORK, 'loose.blend');
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\n' +
    'import bmesh\n' +
    'me = bpy.data.meshes.new("M")\n' +
    'ob = bpy.data.objects.new("M", me)\n' +
    'bpy.context.scene.collection.objects.link(ob)\n' +
    'bm = bmesh.new()\n' +
    'bmesh.ops.create_cube(bm, size=1.0)\n' +
    '[bm.verts.new((9.0 + i, 0.0, 0.0)) for i in range(5)]\n' +
    'bm.to_mesh(me)\nbm.free()', '--save', loose]);
  const r = cli(['export', join(WORK, 'loose.stl'), '--blend', loose]);
  const f = r.json?.result?.exported?.fidelity;
  if (!f?.checked) return `fidelity not checked: ${f?.reason}`;
  if (f.ok) return `5 loose vertices dropped by STL went unreported (scene ${JSON.stringify(f.scene)} file ${JSON.stringify(f.file)})`;
  return f.lost.some(l => l.field === 'verts') ? true : `wrong field flagged: ${JSON.stringify(f.lost)}`;
});

check('export --no-verify skips the readback', () => {
  const out = join(WORK, 'nv.glb');
  const r = cli(['export', out, '--blend', BLEND, '--no-verify']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  return r.json.result?.exported?.fidelity === undefined ? true : 'fidelity ran despite --no-verify';
});

check('import reads a glb back into a scene', () => {
  const r = cli(['import', join(WORK, 'out.glb')]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  return r.json.result?.imported?.count > 0 ? true : 'nothing imported';
});

// --- verify (scene lint) -----------------------------------------------------
check('verify passes a clean scaffolded scene', () => {
  const r = cli(['verify', '--blend', BLEND]);
  if (!r.json?.ok) return `clean scene failed verify: ${r.json?.error}`;
  return r.json.result?.verified?.errors === 0 ? true : 'errors on a clean scene';
});

check('verify flags a missing camera as an error (exit 1)', () => {
  const noCam = join(WORK, 'nocam.blend');
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()', '--save', noCam]);
  const r = cli(['verify', '--blend', noCam]);
  if (r.code === 0) return 'exited 0 with no camera in scene';
  const f = r.json?.result?.verified?.findings || [];
  return f.some(x => x.check === 'no_camera' && x.severity === 'error') ? true : 'no_camera not reported as error';
});

check('verify does NOT call two merely touching boxes an overlap', () => {
  // Cubes are 2 units wide, so centres 2.0 apart share a face exactly.
  const touch = join(WORK, 'touch.blend');
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\n' +
    'bpy.ops.mesh.primitive_cube_add(location=(0,0,0))\nbpy.ops.mesh.primitive_cube_add(location=(2,0,0))', '--save', touch]);
  const r = cli(['verify', '--blend', touch, '--fail-on', 'none']);
  const f = r.json?.result?.verified?.findings || [];
  const ov = f.filter(x => x.check === 'overlap');
  return ov.length === 0 ? true : `touching cubes reported as overlap: ${JSON.stringify(ov)}`;
});

check('verify DOES flag a real interpenetration', () => {
  const olap = join(WORK, 'olap.blend');
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\n' +
    'bpy.ops.mesh.primitive_cube_add(location=(0,0,0))\nbpy.ops.mesh.primitive_cube_add(location=(1,0,0))', '--save', olap]);
  const r = cli(['verify', '--blend', olap, '--fail-on', 'none']);
  const f = r.json?.result?.verified?.findings || [];
  const ov = f.find(x => x.check === 'overlap');
  if (!ov) return 'real overlap not detected';
  return ov.depth?.every(d => d > 0) ? true : `bad depth: ${JSON.stringify(ov.depth)}`;
});

check('verify --fail-on none always exits 0', () => {
  const noCam = join(WORK, 'nocam.blend');
  const r = cli(['verify', '--blend', noCam, '--fail-on', 'none']);
  return r.code === 0 ? true : `exited ${r.code}`;
});

check('verify rejects a bad --fail-on value', () => {
  const r = cli(['verify', '--blend', BLEND, '--fail-on', 'banana']);
  return r.code !== 0 ? true : 'accepted an invalid --fail-on';
});

// --- batch -------------------------------------------------------------------
check('render --batch renders every matched blend', () => {
  const a = join(WORK, 'b_one.blend'), b = join(WORK, 'b_two.blend');
  cli(['new', 'one', '--save', a]);
  cli(['new', 'two', '--save', b]);
  const outDir = join(WORK, 'batchout');
  const r = cli(['render', '--batch', join(WORK, 'b_*.blend'), '--out', outDir,
    '--engine', 'eevee', '--samples', '4', '--res', '96x72']);
  if (!r.json?.ok) return `batch not ok: ${JSON.stringify(r.json?.result?.items?.map(i => i.error))}`;
  if (r.json.result?.total !== 2) return `matched ${r.json.result?.total} files, expected 2`;
  return existsSync(join(outDir, 'b_one.png')) && existsSync(join(outDir, 'b_two.png'))
    ? true : 'named outputs missing';
});

check('batch survives one bad file and reports it (exit 1)', () => {
  const bad = join(WORK, 'b_broken.blend');
  writeFileSync(bad, 'not a blend file');
  const r = cli(['render', '--batch', join(WORK, 'b_*.blend'), '--out', join(WORK, 'batchout2'),
    '--engine', 'eevee', '--samples', '4', '--res', '96x72']);
  rmSync(bad, { force: true });
  if (r.code === 0) return 'exited 0 despite a failed item';
  const res = r.json?.result;
  if (!res) return 'no batch result';
  if (res.failed !== 1) return `expected 1 failure, got ${res.failed}`;
  return res.succeeded === 2 ? true : `expected 2 successes, got ${res.succeeded}`;
});

check('import --batch gathers many files into one scene', () => {
  const g1 = join(WORK, 'g1.glb'), g2 = join(WORK, 'g2.glb');
  cli(['export', g1, '--blend', BLEND, '--no-verify']);
  cli(['export', g2, '--blend', BLEND, '--no-verify']);
  const r = cli(['import', '--batch', join(WORK, 'g?.glb')]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const b = r.json.result?.imported_batch;
  if (b?.total !== 2) return `matched ${b?.total}, expected 2`;
  return b.objects >= 2 ? true : `only ${b.objects} objects landed`;
});

check('batch with no matches fails loudly', () => {
  const r = cli(['render', '--batch', join(WORK, 'nothing_*.blend'), '--out', WORK]);
  return r.code !== 0 && /matched no files/.test(r.json?.error || '') ? true : 'silent on empty match';
});

// --- generate (arg handling only; the network path needs MESHY_API_KEY) ------
check('generate --image rejects a missing file before calling the API', () => {
  const r = cli(['generate', '--image', join(WORK, 'nope.png')]);
  return r.code !== 0 && /image not found/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('generate --image rejects an unsupported image format', () => {
  const bad = join(WORK, 'ref.tiff');
  writeFileSync(bad, 'x');
  const r = cli(['generate', '--image', bad]);
  return r.code !== 0 && /unsupported image format/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('generate with neither prompt nor --image explains itself', () => {
  const r = cli(['generate']);
  return r.code !== 0 && /missing prompt/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

// --- 0.4.0: version-aware animation, API drift guard, doctor api ----------------
const ANIM = join(WORK, 'anim.blend');
check('scene reports keyframe counts on an animated file (slotted or legacy actions)', () => {
  cli(['exec', 'o = bpy.data.objects["Cube"]\no.keyframe_insert("location", frame=1)\no.location.x = 3\no.keyframe_insert("location", frame=10)',
    '--blend', BLEND, '--save', ANIM]);
  const r = cli(['scene', '--blend', ANIM]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const cube = r.json.result.objects.find(o => o.name === 'Cube');
  if (!cube) return 'no Cube in scene';
  if (cube.fcurves !== 3) return `expected 3 fcurves, got ${cube.fcurves}`;
  if (cube.keyframes !== 6) return `expected 6 keyframes, got ${cube.keyframes}`;
  return JSON.stringify(cube.frames) === JSON.stringify([1, 10]) ? true : `frames ${JSON.stringify(cube.frames)}`;
});

check('exec --check reports only the API drift that applies to this build', () => {
  const r = cli(['exec', 'n = len(o.animation_data.action.fcurves)\no.keyframe_insert("rotation")\nsc.render.engine = "BLENDER_EEVEE"', '--check']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const ids = (r.json.result.api_drift || []).map(d => d.id);
  const [maj, min] = r.json.result.bpy_version || [];
  if (!ids.includes('rotation-data-path')) return `version-independent row missing: ${ids}`;
  if (maj >= 5 && !ids.includes('action-fcurves')) return `5.x build but action-fcurves not flagged: ${ids}`;
  if (maj < 5 && ids.includes('action-fcurves')) return `pre-5.0 build but action-fcurves flagged: ${ids}`;
  const legacyEevee = maj === 4 && min >= 2;
  if (legacyEevee && !ids.includes('eevee-legacy-id')) return '4.2-4.5 build but eevee-legacy-id not flagged';
  if (!legacyEevee && ids.includes('eevee-legacy-id')) return 'eevee-legacy-id flagged outside 4.2-4.5';
  return true;
});

check('a failed exec carries the matching drift hint', () => {
  const r = cli(['exec', 'bpy.ops.import_scene.obj(filepath="x.obj")']);
  if (r.code === 0) return 'a removed operator succeeded?';
  const [maj] = r.json?.bpy_version || [];
  if (maj < 4) return true; // still exists there, so no hint is the right answer
  const ids = (r.json?.api_drift || []).map(d => d.id);
  return ids.includes('import-scene-obj') ? true : `no hint: ${JSON.stringify(r.json?.api_drift)}`;
});

check('doctor reports the API generation and enabled add-ons', () => {
  const r = cli(['doctor']);
  const api = r.json?.api;
  if (!api) return 'no api block';
  if (!['slotted', 'legacy'].includes(api.actions)) return `actions: ${api.actions}`;
  if (!['compositing_node_group', 'node_tree'].includes(api.compositor)) return `compositor: ${api.compositor}`;
  return Array.isArray(r.json.addons_enabled) ? true : 'no addons_enabled';
});

// --- 0.4.0: add / keyframe / material verbs -----------------------------------
const VERBS = join(WORK, 'verbs.blend');
check('add builds a named primitive at a position', () => {
  cli(['new', 'verbs', '--save', VERBS]);
  const r = cli(['add', 'cube', '--name', 'Box', '--at', '1,2,3', '--size', '1', '--rot', '0,0,45', '--blend', VERBS, '--save', VERBS]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const a = r.json.result.added?.[0];
  if (a?.name !== 'Box') return `name ${a?.name}`;
  if (JSON.stringify(a.location) !== JSON.stringify([1, 2, 3])) return `location ${JSON.stringify(a.location)}`;
  return Math.abs(a.rotation_deg[2] - 45) < 0.01 ? true : `rotation ${JSON.stringify(a.rotation_deg)}`;
});

check('add --json builds several objects in one launch', () => {
  const ops = [{ what: 'sphere', name: 'Ball', at: [3, 0, 0] }, { what: 'light', type: 'sun', name: 'Sun', energy: 3, color: '#ff8800' },
    { what: 'camera', name: 'Cam2', at: [6, -6, 4], look_at: [0, 0, 0] }, { what: 'text', name: 'Label', text: 'hi' }];
  const r = cli(['add', '--json', JSON.stringify(ops), '--blend', VERBS, '--save', VERBS]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const names = r.json.result.added.map(a => a.name);
  if (JSON.stringify(names) !== JSON.stringify(['Ball', 'Sun', 'Cam2', 'Label'])) return `names ${names}`;
  const s = cli(['scene', '--blend', VERBS]).json?.result;
  return s?.lights?.includes('Sun') && s?.cameras?.includes('Cam2') ? true : 'scene does not list the new light/camera';
});

check('add rejects an unknown kind (exit 1)', () => {
  const r = cli(['add', 'banana', '--blend', VERBS]);
  return r.code !== 0 && /unknown object kind/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('keyframe inserts keys, honours --interp and extends the frame range', () => {
  const a = cli(['keyframe', 'Box', '--prop', 'location', '--frame', '1', '--value', '1,2,3', '--blend', VERBS, '--save', VERBS]);
  if (!a.json?.ok) return a.json?.error || 'first key not ok';
  const b = cli(['keyframe', 'Box', '--prop', 'location', '--frame', '300', '--value', '5,2,3', '--interp', 'linear', '--blend', VERBS, '--save', VERBS]);
  if (!b.json?.ok) return b.json?.error || 'second key not ok';
  if (b.json.result.frame_end_extended !== 300) return `frame_end_extended ${b.json.result.frame_end_extended}`;
  const anim = b.json.result.animation?.Box;
  return anim?.keyframes === 6 && anim.fcurves === 3 ? true : `animation ${JSON.stringify(anim)}`;
});

check('keyframe --json batches keys, including a dotted data path', () => {
  const ops = [{ object: 'Box', prop: 'rotation', frame: 1, value: [0, 0, 0] }, { object: 'Box', prop: 'rotation', frame: 60, value: [0, 0, 360] },
    { object: 'Sun', prop: 'data.energy', frame: 1, value: 3 }, { object: 'Sun', prop: 'data.energy', frame: 30, value: 9 }];
  const r = cli(['keyframe', '--json', JSON.stringify(ops), '--blend', VERBS, '--save', VERBS]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  if (r.json.result.keyed?.length !== 4) return `keyed ${r.json.result.keyed?.length}`;
  const sun = r.json.result.animation?.Sun;
  return sun?.data?.keyframes === 2 ? true : `Sun data keys: ${JSON.stringify(sun)}`;
});

check('keyframe names a missing object loudly (exit 1)', () => {
  const r = cli(['keyframe', 'Nope', '--frame', '1', '--blend', VERBS]);
  return r.code !== 0 && /no object named/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('material assigns a Principled material using the 4.0+ socket names', () => {
  const r = cli(['material', 'Box', '--color', '#cc2222', '--roughness', '0.3', '--metallic', '1', '--emission', '0.1,0.1,0.8', '--blend', VERBS, '--save', VERBS]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const m = r.json.result.material;
  if (m.inputs?.base_color !== 'Base Color') return `inputs ${JSON.stringify(m.inputs)}`;
  if (!m.inputs.emission) return 'emission not set';
  const s = cli(['scene', '--blend', VERBS]).json?.result;
  return s?.materials?.includes(m.name) ? true : `scene materials ${JSON.stringify(s?.materials)}`;
});

// --- 0.4.0: render --device auto / --threads ------------------------------------
check('render --device auto picks a Cycles device and reports it', () => {
  const r = cli(['render', '--blend', BLEND, '--out', join(WORK, 'auto.png'), '--engine', 'cycles', '--device', 'auto', '--samples', '4', '--res', '96x72']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const d = r.json.result?.device;
  if (!d || d.requested !== 'auto') return `device ${JSON.stringify(d)}`;
  return ['OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI', 'CPU'].includes(d.type) ? true : `type ${d.type}`;
});

check('render --threads N is honoured and reported', () => {
  const r = cli(['render', '--blend', BLEND, '--out', join(WORK, 'threads.png'), '--engine', 'eevee', '--samples', '4', '--res', '96x72', '--threads', '2']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  return r.json.result?.threads === 2 ? true : `threads ${r.json.result?.threads}`;
});

check('render rejects a bad --threads value', () => {
  const r = cli(['render', '--blend', BLEND, '--out', join(WORK, 'x.png'), '--threads', '0']);
  return r.code !== 0 && /invalid --threads/.test(r.json?.error || '') ? true : 'accepted --threads 0';
});

// --- 0.4.0: verify mesh health --------------------------------------------------
const MESHES = join(WORK, 'meshes.blend');
check('verify flags a concave UCX_ collider and passes a convex one', () => {
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\n' +
    'import bmesh\n' +
    'def mk(name, loc):\n' +
    '    me = bpy.data.meshes.new(name); ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); ob.location = loc\n' +
    '    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(me); bm.free(); return ob\n' +
    'mk("UCX_Good", (0, 0, 0))\n' +
    'b = mk("UCX_Bad", (5, 0, 0)); b.data.vertices[0].co = (0.1, 0.1, 0.1)\n' +
    'c = mk("Loose", (10, 0, 0)); bm = bmesh.new(); bm.from_mesh(c.data); [bm.verts.new((9.0 + i, 0.0, 0.0)) for i in range(3)]; bm.to_mesh(c.data); bm.free()\n' +
    'd = mk("Mods", (15, 0, 0)); d.modifiers.new("Multires", "MULTIRES"); d.modifiers.new("Subsurf", "SUBSURF")\n' +
    'e = mk("Flipped", (20, 0, 0)); e.data.flip_normals()\n' +
    'cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); bpy.context.scene.collection.objects.link(cam); bpy.context.scene.camera = cam',
  '--save', MESHES]);
  const r = cli(['verify', '--blend', MESHES, '--fail-on', 'none']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const f = r.json.result.verified.findings;
  const has = (obj, chk) => f.some(x => x.object === obj && x.check === chk);
  if (!has('UCX_Bad', 'concave_collider')) return 'concave collider not flagged';
  if (has('UCX_Good', 'concave_collider')) return 'convex collider falsely flagged';
  return r.json.result.verified.mesh?.UCX_Good?.convex === true ? true : 'no convex stat on the good collider';
});

check('verify flags loose geometry, inverted normals and Multires-not-last', () => {
  const r = cli(['verify', '--blend', MESHES, '--fail-on', 'none']);
  const f = r.json?.result?.verified?.findings || [];
  const has = (obj, chk) => f.some(x => x.object === obj && x.check === chk);
  if (!has('Loose', 'loose_geometry')) return 'loose_geometry missing';
  if (!has('Flipped', 'inverted_normals')) return 'inverted_normals missing';
  if (!has('Mods', 'multires_not_last')) return 'multires_not_last missing';
  return has('UCX_Good', 'loose_geometry') || has('UCX_Good', 'inverted_normals') ? 'clean cube falsely flagged' : true;
});

check('verify --no-mesh skips the mesh pass', () => {
  const r = cli(['verify', '--blend', MESHES, '--fail-on', 'none', '--no-mesh']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  if (r.json.result.verified.findings.some(x => x.check === 'concave_collider')) return 'mesh finding present despite --no-mesh';
  return Object.keys(r.json.result.verified.mesh || {}).length === 0 ? true : 'mesh stats present';
});

// --- 0.4.0: export animation census ---------------------------------------------
// No lights in this fixture: Blender 5.1's own FBX importer trips on lights
// during the readback, which would mask what the census is being asked to prove.
const ANIM_NOLIGHT = join(WORK, 'anim_nolight.blend');
check('export glb carries animation through the census', () => {
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\no = bpy.context.object\no.keyframe_insert("location", frame=1)\no.location.x = 3\no.keyframe_insert("location", frame=10)',
    '--save', ANIM_NOLIGHT]);
  const r = cli(['export', join(WORK, 'anim.glb'), '--blend', ANIM_NOLIGHT]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const e = r.json.result.exported;
  if (e.animation?.objects !== 1) return `animation block ${JSON.stringify(e.animation)}`;
  const fid = e.fidelity;
  if (!fid?.checked) return `not checked: ${fid?.reason}`;
  if (!fid.compared.includes('animated')) return 'animated not compared';
  return fid.ok && fid.file.animated === 1 ? true : `fidelity ${JSON.stringify(fid)}`;
});

check('export fbx carries animation through the census', () => {
  const r = cli(['export', join(WORK, 'anim.fbx'), '--blend', ANIM_NOLIGHT]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const fid = r.json.result.exported.fidelity;
  if (!fid?.checked) return `not checked: ${fid?.reason}`;
  if (!fid.compared.includes('animated')) return 'animated not compared';
  return fid.ok && fid.file.animated === 1 ? true : `fidelity ${JSON.stringify(fid)}`;
});

check('export usd is not judged on animation it cannot read back', () => {
  const r = cli(['export', join(WORK, 'anim.usd'), '--blend', ANIM_NOLIGHT]);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const fid = r.json.result.exported.fidelity;
  if (!fid?.checked) return `not checked: ${fid?.reason}`;
  if (fid.compared.includes('animated')) return 'usd compared on animation';
  return fid.ok ? true : `degraded ${JSON.stringify(fid.lost)}`;
});

check('export --animations off drops animation and says so', () => {
  const r = cli(['export', join(WORK, 'anim_off.glb'), '--blend', ANIM_NOLIGHT, '--animations', 'off']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const e = r.json.result.exported;
  if (e.animation?.exported !== false) return `exported flag ${JSON.stringify(e.animation)}`;
  if (e.fidelity.compared.includes('animated')) return 'still compared on animation';
  return e.fidelity.ok ? true : `degraded ${JSON.stringify(e.fidelity.lost)}`;
});

// --- 0.4.0: snapshot --------------------------------------------------------------
check('snapshot tiles four views and reports per-view coverage', () => {
  const out = join(WORK, 'sheet.png');
  const r = cli(['snapshot', '--blend', BLEND, '--out', out, '--res', '96x72']);
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const s = r.json.result.snapshot;
  if (!existsSync(out)) return 'no sheet written';
  if (JSON.stringify(s.grid) !== JSON.stringify([2, 2])) return `grid ${JSON.stringify(s.grid)}`;
  if (s.views.length !== 4) return `views ${s.views.length}`;
  const bad = s.views.filter(v => !(v.coverage > 0 && v.coverage < 1) || v.blank || !v.bbox);
  return bad.length ? `bad views ${JSON.stringify(bad)}` : true;
});

check('snapshot on a scene with nothing visible fails loudly', () => {
  const empty = join(WORK, 'empty.blend');
  cli(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)', '--save', empty]);
  const r = cli(['snapshot', '--blend', empty, '--out', join(WORK, 'empty.png')]);
  return r.code !== 0 && /nothing to snapshot/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('snapshot rejects an unknown view', () => {
  const r = cli(['snapshot', '--blend', BLEND, '--out', join(WORK, 'v.png'), '--views', 'front,sideways']);
  return r.code !== 0 && /unknown view/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

// --- 0.4.0: detached jobs -------------------------------------------------------
check('render --detach returns a job id at once; job wait collects result and progress', () => {
  const r = cli(['render', '--blend', BLEND, '--animation', '--frames', '1..3', '--out', join(WORK, 'jobseq'), '--engine', 'eevee', '--samples', '4', '--res', '96x72', '--detach']);
  if (!r.json?.ok || !r.json.job) return r.json?.error || 'no job id';
  const w = cli(['job', 'wait', r.json.job, '--timeout', '170', '--poll', '1']);
  if (!w.json?.ok) return w.json?.error || 'wait not ok';
  if (w.json.status !== 'done') return `status ${w.json.status}`;
  if (w.json.result?.frame_files !== 3) return `frame_files ${w.json.result?.frame_files}`;
  if (w.json.progress?.frames_done !== 3 || w.json.progress?.percent !== 100) return `progress ${JSON.stringify(w.json.progress)}`;
  const l = cli(['job', 'list']);
  return l.json?.jobs?.some(j => j.job === r.json.job && j.status === 'done') ? true : 'job list does not show it done';
});

check('job cancel stops a running render', () => {
  const r = cli(['render', '--blend', BLEND, '--animation', '--frames', '1..200', '--out', join(WORK, 'jobseq2'), '--engine', 'cycles', '--samples', '64', '--res', '256x256', '--detach']);
  if (!r.json?.job) return r.json?.error || 'no job id';
  const c = cli(['job', 'cancel', r.json.job]);
  if (!c.json?.ok) return c.json?.error || 'cancel not ok';
  if (c.json.was !== 'running') return `job was already ${c.json.was}`;
  const s = cli(['job', 'status', r.json.job]);
  return s.json?.status === 'cancelled' ? true : `status ${s.json?.status}`;
});

check('job status on an unknown id fails (exit 1)', () => {
  const r = cli(['job', 'status', 'no-such-job']);
  return r.code !== 0 && /unknown job/.test(r.json?.error || '') ? true : 'unknown job accepted';
});

check('--detach and --batch refuse to combine', () => {
  const r = cli(['render', '--batch', join(WORK, 'b_*.blend'), '--out', WORK, '--detach']);
  return r.code !== 0 && /cannot be combined/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

// --- 0.4.0: add-ons, headless ---------------------------------------------------
// Isolated preferences, so the host's Blender install is never touched.
const PREFS = join(WORK, 'prefs');
const ISO = { BLENDER_USER_RESOURCES: PREFS, BLENDER_USER_CONFIG: join(PREFS, 'config'), BLENDER_USER_SCRIPTS: join(PREFS, 'scripts') };
check('addon install --enable installs a legacy add-on and enables it', () => {
  mkdirSync(PREFS, { recursive: true });
  const tiny = join(WORK, 'tiny_smoke.py');
  writeFileSync(tiny, 'bl_info = {"name": "Tiny Smoke", "author": "smoke", "version": (0, 1), "blender": (3, 0, 0), "category": "Development"}\ndef register(): pass\ndef unregister(): pass\n');
  const r = cli(['addon', 'install', tiny, '--enable'], { env: ISO });
  if (!r.json?.ok) return r.json?.error || 'not ok';
  if (r.json.result.installed?.module !== 'tiny_smoke') return `module ${JSON.stringify(r.json.result.installed)}`;
  return r.json.result.enabled === true ? true : 'not enabled';
});

check('addon list shows it enabled in a fresh session (the enable persisted)', () => {
  const r = cli(['addon', 'list'], { env: ISO });
  if (!r.json?.ok) return r.json?.error || 'not ok';
  const it = r.json.result.addons.find(a => a.module === 'tiny_smoke');
  return it?.enabled ? true : `tiny_smoke ${JSON.stringify(it)}`;
});

check('--addons enables a module for one call', () => {
  const r = cli(['exec', 'result["on"] = "tiny_smoke" in bpy.context.preferences.addons', '--addons', 'tiny_smoke'], { env: ISO });
  return r.json?.ok && r.json.result?.on === true ? true : `unexpected: ${JSON.stringify(r.json)}`;
});

check('--addons fails loudly on a missing module (exit 1)', () => {
  const r = cli(['exec', 'result["x"] = 1', '--addons', 'no_such_addon_xyz'], { env: ISO });
  return r.code !== 0 && /not available/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('--addons rejects a value with spaces', () => {
  const r = cli(['exec', 'result["x"] = 1', '--addons', 'a b']);
  return r.code !== 0 && /invalid --addons/.test(r.json?.error || '') ? true : `unexpected: ${r.json?.error}`;
});

check('addon disable turns it off; list --all still shows it installed', () => {
  const d = cli(['addon', 'disable', 'tiny_smoke'], { env: ISO });
  if (!d.json?.ok || d.json.result.enabled !== false) return d.json?.error || 'disable not ok';
  const r = cli(['addon', 'list', '--all'], { env: ISO });
  const it = r.json?.result?.addons?.find(a => a.module === 'tiny_smoke');
  return it && it.enabled === false ? true : `after disable: ${JSON.stringify(it)}`;
});

// --- 0.4.0: schema ------------------------------------------------------------------
const ALL_COMMANDS = ['doctor', 'new', 'exec', 'run', 'scene', 'verify', 'snapshot', 'add', 'keyframe', 'material', 'import', 'generate', 'export', 'render', 'job', 'addon', 'schema', 'version'];
check('schema lists exactly the command surface, each with a known effects annotation', () => {
  const r = cli(['schema'], { timeout: 20000 });
  if (!r.json?.commands) return 'no commands in schema';
  const spec = r.json.commands.map(c => c.name).sort();
  if (JSON.stringify(spec) !== JSON.stringify([...ALL_COMMANDS].sort())) return `spec set differs: ${spec}`;
  const help = cli(['help'], { timeout: 20000 }).stderr;
  const missing = spec.filter(n => !new RegExp(`^\\s+${n}\\b`, 'm').test(help));
  if (missing.length) return `in schema but not in help: ${missing}`;
  const bad = r.json.commands.filter(c => !c.effects?.length || c.effects.some(e => !r.json.effects_legend[e]));
  return bad.length ? `bad effects on ${bad.map(c => c.name)}` : true;
});

check('schema --skill renders a skill file with frontmatter and every command', () => {
  const r = cli(['schema', '--skill'], { timeout: 20000 });
  if (!r.stdout.startsWith('---\nname: blender-cli')) return 'no frontmatter';
  const missing = ALL_COMMANDS.filter(n => !r.stdout.includes(`blender-cli ${n}`));
  return missing.length ? `missing ${missing}` : true;
});

// --- report ------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed  (Blender ${blenderVersion || '?'}${BLENDER ? ` @ ${BLENDER}` : ''})`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
rmSync(WORK, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
