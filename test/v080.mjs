#!/usr/bin/env node
// 0.8.0 checks: safe-mode allowlist, approval binding, save versions, change
// summaries, import arrival, API drift rows, node labels, job stall detection
// and provider request retries.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = mkdtempSync(join(tmpdir(), 'bcli-v080-'));
const argv = process.argv.slice(2), bi = argv.indexOf('--blender');
const binary = bi < 0 ? [] : ['--blender', argv[bi + 1]];
const SOURCE = join(WORK, 'source.blend');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let passed = 0, failed = 0;
function cli(args, env = {}) {
  const full = args.includes('--blender') ? args : [...args, ...binary];
  const r = spawnSync(process.execPath, [join(ROOT, 'blender-cli'), ...full], {
    encoding: 'utf8', cwd: WORK, timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, BLENDER_CLI_JOBS_DIR: join(WORK, 'jobs'), BLENDER_CLI_CACHE_DIR: join(WORK, 'cache'), ...env },
  });
  let json; try { json = JSON.parse(r.stdout); } catch { throw new Error(`non-JSON result: ${r.stderr || r.stdout}`); }
  assert.equal(r.status, json.ok === false ? 1 : 0, JSON.stringify(json));
  return json;
}
function good(args, env) { const r = cli(args, env); assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function bad(args, pattern, env) { const r = cli(args, env); assert.equal(r.ok, false, JSON.stringify(r)); if (pattern) assert.match(r.error, pattern); return r; }
function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name} — ${e.message}`); }
}

// A provider stand-in in its own process, so the synchronous CLI calls above can reach it.
const SERVER = `
const http = require('node:http'); const fs = require('node:fs');
const hits = {};
const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === '/hits') { res.end(JSON.stringify(hits)); return; }
  if (req.url.startsWith('/assets')) {
    if (hits[req.url] < 3) { res.writeHead(503, { 'retry-after': '0' }); res.end('busy'); return; }
    res.end(JSON.stringify({ flaky_rock: { name: 'Flaky Rock', type: 2, categories: ['rock'], tags: [] } })); return;
  }
  if (req.url.startsWith('/info/')) return; // never answers
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[1], String(server.address().port)));
`;
const portFile = join(WORK, 'port');
const server = spawn(process.execPath, ['-e', SERVER, portFile], { stdio: 'ignore' });

console.log('blender-cli v0.8 checks');
try {
  good(['new', 'v080', '--save', SOURCE]);
  good(['add', 'cube', '--name', 'Asset', '--blend', SOURCE, '--save', SOURCE]);

  check('safe mode refuses dynamic imports, module re-exports and private attributes', () => {
    for (const code of [
      'import importlib\nimportlib.import_module("o" + "s")',
      '__builtins__["__import__"]("os")',
      'import contextlib\ncontextlib.os.getpid()',
      'import random\nrandom._os',
      'import operator, contextlib\noperator.attrgetter("os")(contextlib)',
      'from numpy import distutils',
      'import json\njson.codecs.open("x.txt", "w")',
      'bpy.data.texts.new("t").as_module()',
    ]) {
      const r = bad(['exec', code, '--safe'], /sandbox/);
      assert.ok(r.result?.violations?.length, `no violations for: ${code}`);
    }
  });
  check('safe mode guards computed attribute names and write-mode open at runtime', () => {
    const marker = join(WORK, 'safe-write.txt');
    bad(['exec', 'g = getattr\nimport contextlib\ng(contextlib, "o" + "s")', '--safe'], /attribute 'os' is blocked/);
    bad(['exec', `f = open\nf(${JSON.stringify(marker)}, "w" + "")`, '--safe'], /write\/append mode is blocked/);
    assert.equal(existsSync(marker), false);
  });
  check('safe mode still runs ordinary bmesh, numpy and computed-property code', () => {
    const r = good(['exec', 'import bmesh, numpy as np\nfrom mathutils import Vector\nbm = bmesh.new()\nbmesh.ops.create_cube(bm, size=1)\nresult["verts"] = len(bm.verts)\nbm.free()\nresult["sum"] = float(np.arange(4).sum())\nprop = "location"\nresult["loc"] = [list(getattr(o, prop)) for o in bpy.data.objects]', '--safe', '--blend', SOURCE]);
    assert.equal(r.result.verts, 8); assert.equal(r.result.sum, 6); assert.ok(r.result.loc.length >= 1);
  });

  check('check reports code_sha256 and expect-sha256 runs only the reviewed code', () => {
    const code = 'result["approved"] = True';
    const checked = good(['exec', code, '--check']);
    assert.equal(checked.result.code_sha256, createHash('sha256').update(code).digest('hex'));
    assert.equal(good(['exec', code, '--expect-sha256', checked.result.code_sha256]).result.approved, true);
    const r = bad(['exec', code + ' ', '--expect-sha256', checked.result.code_sha256], /does not match the approved SHA-256/);
    assert.equal(r.expected_sha256, checked.result.code_sha256);
    bad(['exec', code, '--expect-sha256', 'abc'], /64 hex/);
    const script = join(WORK, 'approved.py'); writeFileSync(script, code);
    good(['run', script, '--expect-sha256', checked.result.code_sha256]);
  });

  check('save keeps the replaced scene as .blend1 and --no-backup skips it', () => {
    const scene = join(WORK, 'versions.blend');
    good(['add', 'cube', '--name', 'First', '--blend', SOURCE, '--save', scene]);
    const first = hash(scene);
    const r = good(['add', 'cube', '--name', 'Second', '--blend', scene, '--save', scene]);
    assert.equal(r.result.saved_artifact.backup.path, scene + '1');
    assert.equal(hash(scene + '1'), first);
    assert.equal(r.result.saved_artifact.backup.sha256, first);
    const backupBefore = hash(scene + '1');
    const n = good(['add', 'cube', '--name', 'Third', '--blend', scene, '--save', scene, '--no-backup']);
    assert.equal(n.result.saved_artifact.backup, undefined);
    assert.equal(hash(scene + '1'), backupBefore);
    const names = good(['scene', '--blend', scene + '1']).result.objects.map(o => o.name);
    assert.ok(names.includes('First') && !names.includes('Second'));
  });

  check('--diff reports added and changed objects for a mutating command', () => {
    const added = good(['add', 'sphere', '--name', 'Ball', '--blend', SOURCE, '--diff']);
    assert.deepEqual(added.result.changes.objects.added, ['Ball']);
    assert.equal(added.result.changes.changed, true);
    const moved = good(['exec', 'bpy.data.objects["Asset"].location.x += 2', '--blend', SOURCE, '--diff']);
    assert.deepEqual(moved.result.changes.objects.changed.map(c => c.name), ['Asset']);
    assert.ok(moved.result.changes.objects.changed[0].fields.includes('matrix_world'));
    const none = good(['exec', 'result["x"] = 1', '--blend', SOURCE, '--diff']);
    assert.equal(none.result.changes.changed, false);
    assert.equal(good(['exec', 'result["x"] = 1', '--blend', SOURCE]).result.changes, undefined);
  });

  check('import fails when a file adds no objects and reports hierarchy roots', () => {
    const empty = join(WORK, 'empty.obj'); writeFileSync(empty, '# no geometry\n');
    bad(['import', empty], /added no objects/);
    assert.equal(good(['import', empty, '--allow-empty']).result.imported.count, 0);
    const glb = join(WORK, 'family.glb');
    good(['exec', 'p = bpy.data.objects["Asset"]\nbpy.ops.mesh.primitive_cube_add()\nc = bpy.context.active_object\nc.name = "Child"\nc.parent = p', '--blend', SOURCE, '--save', join(WORK, 'family.blend')]);
    good(['export', glb, '--blend', join(WORK, 'family.blend')]);
    const r = good(['import', glb]);
    const child = r.result.imported.objects.find(o => o.name.startsWith('Child'));
    assert.ok(child?.parent?.startsWith('Asset'), JSON.stringify(r.result.imported.objects));
    assert.ok(r.result.imported.roots.some(n => n.startsWith('Asset')) && !r.result.imported.roots.some(n => n.startsWith('Child')));
    const batch = bad(['import', '--batch', join(WORK, '*.obj')], /failed to import/);
    assert.match(batch.result.imported_batch.items[0].error, /added no objects/);
  });

  check('API drift names the 4.x and 5.x removals that apply to this build', () => {
    const code = 'import bgl\nm = bpy.data.meshes.new("m")\nm.use_auto_smooth = True\nm.calc_normals()\nng = bpy.data.node_groups.new("g", "GeometryNodeTree")\nng.inputs.new("NodeSocketFloat", "x")\nbpy.context.scene.sequence_editor.sequences_all';
    const r = good(['exec', code, '--check']);
    const ids = r.result.api_drift.map(d => d.id);
    const v = r.result.bpy_version;
    for (const id of ['mesh-auto-smooth', 'mesh-calc-normals', 'node-group-sockets']) assert.ok(ids.includes(id), `missing ${id}: ${ids}`);
    const five = v[0] >= 5;
    assert.equal(ids.includes('bgl-module'), five); assert.equal(ids.includes('vse-sequences'), five);
    const failedRun = bad(['exec', 'm = bpy.data.meshes.new("m")\nm.use_auto_smooth = True']);
    assert.ok(failedRun.api_drift?.some(d => d.id === 'mesh-auto-smooth'), JSON.stringify(failedRun.api_drift));
  });

  check('nodes find returns human labels and descriptions, without abstract bases', () => {
    const r = good(['nodes', 'find', '--kind', 'geometry', '--search', 'set position']);
    const node = r.result.nodes.find(n => n.id === 'GeometryNodeSetPosition');
    assert.equal(node?.label, 'Set Position'); assert.ok(node.description.length > 0);
    const all = good(['nodes', 'find', '--kind', 'all', '--limit', '500']);
    assert.equal(all.result.nodes.some(n => ['GeometryNode', 'ShaderNode', 'CompositorNode'].includes(n.type)), false);
  });

  check('job wait --stall-after returns when a running job stops writing output', () => {
    const started = good(['exec', 'import time\ntime.sleep(30)', '--detach', '--timeout', '40']);
    sleep(1500);
    const s = good(['job', 'status', started.job]);
    assert.equal(s.status, 'running'); assert.ok(Number.isInteger(s.idle_s));
    const w = bad(['job', 'wait', started.job, '--stall-after', '2', '--poll', '0.5'], /no output from Blender/);
    assert.equal(w.stalled, true); assert.equal(w.status, 'running');
    good(['job', 'cancel', started.job]);
    bad(['job', 'wait', started.job, '--stall-after', '0'], /invalid --stall-after/);
  });

  check('provider requests retry transient failures and time out instead of hanging', () => {
    for (let i = 0; i < 100 && !existsSync(portFile); i++) sleep(50);
    const base = `http://127.0.0.1:${readFileSync(portFile, 'utf8')}`;
    const env = { POLYHAVEN_API_BASE: base, BLENDER_CLI_HTTP_TIMEOUT: '1', BLENDER_CLI_HTTP_RETRIES: '3' };
    const r = good(['assets', 'search', 'rock', '--refresh'], env);
    assert.equal(r.assets[0].id, 'flaky_rock');
    const t0 = Date.now();
    bad(['import', 'polyhaven:stuck_asset'], /timed out after 2s/, { ...env, BLENDER_CLI_HTTP_TIMEOUT: '2' });
    assert.ok(Date.now() - t0 < 6000, 'a timed-out request was retried or not bounded');
    const hits = JSON.parse(spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(base + '/hits')}).then(r => r.text()).then(t => process.stdout.write(t))`], { encoding: 'utf8' }).stdout);
    assert.equal(hits['/assets'], 3, JSON.stringify(hits));
  });
} catch (e) { failed++; console.log(`  FAIL  fixture setup — ${e.message}`); }
finally { server.kill(); rmSync(WORK, { recursive: true, force: true }); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
