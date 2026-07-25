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
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
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

function cli(args, { timeout = 180000 } = {}) {
  const full = BLENDER ? [...args, '--blender', BLENDER] : args;
  const r = spawnSync(process.execPath, [CLI, ...full], {
    encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, cwd: WORK,
    stdio: ['ignore', 'pipe', 'pipe'],
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

// --- report ------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed  (Blender ${blenderVersion || '?'}${BLENDER ? ` @ ${BLENDER}` : ''})`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
rmSync(WORK, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
