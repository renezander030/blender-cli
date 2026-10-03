#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = mkdtempSync(join(tmpdir(), 'bcli-release-'));
const argv = process.argv.slice(2), bi = argv.indexOf('--blender');
const binary = bi < 0 ? [] : ['--blender', argv[bi + 1]];
const SOURCE = join(WORK, 'source.blend');
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
function good(args) { const r = cli(args); assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function bad(args, pattern) { const r = cli(args); assert.equal(r.ok, false, JSON.stringify(r)); if (pattern) assert.match(r.error, pattern); return r; }
function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name} — ${e.message}`); }
}
console.log('blender-cli v0.7 regression checks');
try {
  good(['new', 'release', '--save', SOURCE]);
  good(['add', 'cube', '--name', 'Asset', '--blend', SOURCE, '--save', SOURCE]);
  check('save failures preserve the existing scene and remove staging files', () => {
    const before = hash(SOURCE);
    bad(['exec', 'raise RuntimeError("intentional save failure")', '--blend', SOURCE, '--save', SOURCE], /intentional/);
    assert.equal(hash(SOURCE), before);
    assert.equal(readdirSync(WORK).some(f => f.startsWith('.blender-cli-save-')), false);
  });
  check('a changed destination is refused before publishing a scene save', () => {
    const bytes = readFileSync(SOURCE);
    try {
      bad(['exec', `with open(${JSON.stringify(SOURCE)}, "ab") as f: f.write(b"external-edit")`, '--blend', SOURCE, '--save', SOURCE], /destination changed/);
      assert.deepEqual(readFileSync(SOURCE), Buffer.concat([bytes, Buffer.from('external-edit')]));
    } finally { writeFileSync(SOURCE, bytes); }
    assert.equal(readdirSync(WORK).some(f => f.startsWith('.blender-cli-save-')), false);
  });
  check('successful scene saves return a matching content hash', () => {
    const r = good(['exec', 'result["updated"] = True', '--blend', SOURCE, '--save', SOURCE]);
    assert.equal(r.result.saved_artifact.sha256, hash(SOURCE));
  });
  check('timeouts clean staged saves for synchronous and detached jobs', () => {
    const before = hash(SOURCE);
    const code = 'with open(PARAMS["__save_stage__"], "wb") as f: f.write(b"partial-save")\ntime.sleep(10)';
    bad(['exec', code, '--blend', SOURCE, '--save', SOURCE, '--timeout', '1'], /timed out/);
    const start = good(['exec', code, '--blend', SOURCE, '--save', SOURCE, '--timeout', '1', '--detach']);
    bad(['job', 'wait', start.job, '--timeout', '10', '--poll', '0.1'], /timeout/);
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    assert.equal(hash(SOURCE), before);
    assert.equal(readdirSync(WORK).some(f => f.startsWith('.blender-cli-save-')), false);
  });
  check('scene diff detects transform, hierarchy and evaluated geometry changes', () => {
    const same = good(['diff', SOURCE, SOURCE, '--fail-on-change']); assert.equal(same.changed, false);
    const other = join(WORK, 'other.blend');
    good(['exec', 'o=bpy.data.objects["Asset"]; o.location.x=2; o.data.vertices[0].co.z += 0.5; o.parent=bpy.data.objects["Camera"]', '--blend', SOURCE, '--save', other]);
    const r = bad(['diff', SOURCE, other, '--fail-on-change'], /found changes/);
    const fields = r.objects.changed.find(x => x.name === 'Asset').fields;
    for (const field of ['matrix_world', 'parent', 'geometry']) assert.ok(fields.includes(field), JSON.stringify(r));
  });
  check('invalid acceptance rules fail before producing receipts', () => {
    const cases = [{ required_object: ['Asset'] }, { version: 2 }, { min_objects: true }, { max_errors: '0' },
      { required_objects: [{}] }, { required_objects: [{ name: 'Asset', typo: 1 }] }, { forbidden_objects: [null] },
      { frame_range: [10, 1] }, { tolerance: -1 }, { snapshot: { min_coverage: '0.2' } },
      { snapshot: { views: '' } }, { snapshot: { res: '0x10' } }, { snapshot: { typo: true } }];
    for (const spec of cases) {
      const path = join(WORK, 'invalid.json'), receipt = join(WORK, 'invalid.receipt.json');
      writeFileSync(path, JSON.stringify(spec)); bad(['accept', path, '--blend', SOURCE, '--receipt', receipt]);
      assert.equal(existsSync(receipt), false);
    }
  });
  check('acceptance outputs cannot overwrite their source or spec', () => {
    const spec = join(WORK, 'collision.json'); writeFileSync(spec, '{}'); const before = hash(SOURCE);
    bad(['accept', spec, '--blend', SOURCE, '--receipt', SOURCE], /must not overwrite/);
    assert.equal(hash(SOURCE), before);
  });
  check('receipt verification detects changed specs and missing snapshots', () => {
    const spec = join(WORK, 'accept.json'), receipt = join(WORK, 'accept.receipt.json');
    const value = { required_objects: ['Asset'], snapshot: { out: 'proof.png', res: '32x32', views: 'front', min_coverage: 0 } };
    writeFileSync(spec, JSON.stringify(value)); good(['accept', spec, '--blend', SOURCE, '--receipt', receipt]);
    good(['receipt', 'verify', receipt]); writeFileSync(spec, JSON.stringify({ ...value, min_objects: 99 }));
    bad(['receipt', 'verify', receipt], /changed/); writeFileSync(spec, JSON.stringify(value));
    rmSync(join(WORK, 'proof.png')); bad(['receipt', 'verify', receipt], /missing/);
  });
  check('receipt verification rejects failed and incomplete evidence', () => {
    const path = join(WORK, 'failed.receipt.json');
    writeFileSync(path, JSON.stringify({ schema_version: 1, tool: 'blender-cli', passed: false }));
    bad(['receipt', 'verify', path], /unsupported|incomplete|failed/);
  });
  check('live export options accept valid values and reject bad types or output overrides', () => {
    good(['export', join(WORK, 'options.glb'), '--blend', SOURCE, '--options', '{"export_apply":false}', '--strict']);
    bad(['export', join(WORK, 'invalid.glb'), '--blend', SOURCE, '--options', '{"export_apply":"false"}'], /invalid type/);
    assert.equal(existsSync(join(WORK, 'invalid.glb')), false);
    bad(['export', join(WORK, 'invalid.glb'), '--blend', SOURCE, '--options', '{"filepath":"wrong.glb"}'], /controlled/);
    bad(['export', join(WORK, 'invalid.glb'), '--blend', SOURCE, '--options', '{"unknown_option":true}'], /unknown export option/);
    bad(['export', join(WORK, 'invalid.glb'), '--blend', SOURCE, '--strict', '--no-verify'], /requires readback/);
  });
  check('non-mesh evaluated geometry participates in export fidelity', () => {
    const scene = join(WORK, 'meta.blend');
    good(['exec', 'bpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.object.metaball_add(type="BALL")', '--save', scene]);
    const r = cli(['export', join(WORK, 'meta.glb'), '--blend', scene, '--strict']);
    const f = r.result?.exported?.fidelity; assert.ok(f?.checked, JSON.stringify(r));
    assert.ok(f.detail.scene_geometry.some(g => g.type === 'META' && g.vertices > 0), JSON.stringify(f));
    assert.ok(f.compared.includes('geometry_payloads'));
    if (f.file.geometry_payloads < f.scene.geometry_payloads) assert.equal(r.ok, false);
  });
  check('strict export refuses an unavailable importer instead of passing', () => {
    const out = join(WORK, 'options.glb'), fake = join(WORK, 'unavailable-importer');
    const payload = { ok: true, result: { exported: { file: out, format: 'glb', fidelity: { checked: false, reason: 'importer unavailable' } } } };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    writeFileSync(fake, `#!/usr/bin/env node\nconsole.log('__BLENDER_CLI__${encoded}__END__');\n`, { mode: 0o755 });
    bad(['export', out, '--blend', SOURCE, '--strict', '--blender', fake], /verification unavailable/);
  });
  check('glTF bundle proof includes buffer and texture sidecars', () => {
    const scene = join(WORK, 'textured.blend');
    good(['exec', `img=bpy.data.images.new("ReleaseTexture", width=4, height=4)
img.generated_color=(0.7,0.1,0.2,1)
img.filepath_raw=${JSON.stringify(join(WORK, 'texture.png'))}; img.file_format="PNG"; img.save()
mat=bpy.data.materials.new("Textured"); mat.use_nodes=True
tex=mat.node_tree.nodes.new("ShaderNodeTexImage"); tex.image=img
bsdf=next(n for n in mat.node_tree.nodes if n.type=="BSDF_PRINCIPLED")
mat.node_tree.links.new(tex.outputs["Color"],bsdf.inputs["Base Color"])
bpy.data.objects["Asset"].data.materials.append(mat)`, '--blend', SOURCE, '--save', scene]);
    const r = good(['export', join(WORK, 'textured.gltf'), '--blend', scene, '--strict']);
    const artifacts = r.result.exported.artifacts; assert.ok(artifacts.length >= 3, JSON.stringify(artifacts));
    for (const artifact of artifacts) assert.equal(artifact.sha256, hash(artifact.path));
    assert.match(r.result.exported.bundle_sha256, /^[0-9a-f]{64}$/);
    const image = good(['exec', 'result["image_path"]=bpy.path.abspath(bpy.data.images["ReleaseTexture"].filepath)', '--blend', scene]);
    assert.equal(image.result.image_path, join(WORK, 'texture.png'));
  });
  const A = join(WORK, 'batch-a.blend'), B = join(WORK, 'batch-b.blend');
  copyFileSync(SOURCE, A); copyFileSync(SOURCE, B);
  const pattern = join(WORK, 'batch-*.blend'), renderDir = join(WORK, 'renders'), manifest = join(WORK, 'render-manifest.json');
  const renderArgs = ['render', '--batch', pattern, '--out', renderDir, '--engine', 'workbench', '--res', '32x24', '--manifest', manifest];
  check('batch resume skips only inputs/options/artifacts that still match', () => {
    assert.equal(good(renderArgs).result.skipped, 0);
    assert.equal(good([...renderArgs, '--resume']).result.skipped, 2);
    writeFileSync(join(renderDir, 'batch-a.png'), 'corrupt-output');
    assert.equal(good([...renderArgs, '--resume']).result.skipped, 1);
    good(['exec', 'bpy.data.objects["Asset"].location.x += 1', '--blend', B, '--save', B]);
    assert.equal(good([...renderArgs, '--resume']).result.skipped, 1);
    const newArgs = renderArgs.map(x => x === '32x24' ? '36x28' : x);
    assert.equal(good([...newArgs, '--resume']).result.skipped, 0);
  });
  check('batch resume reruns when an external image changes without a scene edit', () => {
    copyFileSync(join(WORK, 'textured.blend'), A); copyFileSync(join(WORK, 'textured.blend'), B);
    good(renderArgs); assert.equal(good([...renderArgs, '--resume']).result.skipped, 2);
    const texture = join(WORK, 'texture.png');
    writeFileSync(texture, Buffer.concat([readFileSync(texture), Buffer.from('texture-edit')]));
    assert.equal(good([...renderArgs, '--resume']).result.skipped, 0);
    copyFileSync(SOURCE, A); copyFileSync(SOURCE, B);
  });
  check('batch acceptance checks each source and continues after a rejected item', () => {
    const spec = join(WORK, 'batch-accept.json'), out = join(WORK, 'gated');
    writeFileSync(spec, JSON.stringify({ required_objects: ['Asset'], snapshot: { res: '32x32', views: 'front', min_coverage: 0 } }));
    good(['exec', 'bpy.data.objects.remove(bpy.data.objects["Asset"], do_unlink=True)', '--blend', B, '--save', B]);
    const r = bad(['render', '--batch', pattern, '--out', out, '--engine', 'workbench', '--res', '32x24', '--accept', spec]);
    assert.equal(r.result.succeeded, 1); assert.equal(r.result.failed, 1);
    assert.equal(existsSync(join(out, 'batch-a.png')), true); assert.equal(existsSync(join(out, 'batch-b.png')), false);
    good(['receipt', 'verify', join(out, 'batch-a.acceptance.receipt.json')]);
    bad(['receipt', 'verify', join(out, 'batch-b.acceptance.receipt.json')]);
  });
  check('export resume rechecks glTF sidecars instead of trusting the main file', () => {
    copyFileSync(SOURCE, B);
    const out = join(WORK, 'exports'), ledger = join(WORK, 'export-manifest.json');
    const args = ['export', out, '--batch', pattern, '--format', 'gltf', '--strict', '--manifest', ledger];
    good(args); assert.equal(good([...args, '--resume']).result.skipped, 2);
    const value = JSON.parse(readFileSync(ledger, 'utf8'));
    const buffer = value.items[A].artifacts.find(x => x.path.endsWith('.bin'));
    writeFileSync(buffer.path, 'corrupt-buffer');
    assert.equal(good([...args, '--resume']).result.skipped, 1);
  });
  check('manifests cannot overwrite sidecars, acceptance specs or unrelated JSON files', () => {
    const buffer = join(WORK, 'exports', 'batch-a.bin'), before = hash(buffer);
    bad(['export', join(WORK, 'exports'), '--batch', pattern, '--format', 'gltf', '--manifest', buffer], /\.json file/);
    assert.equal(hash(buffer), before);
    const spec = join(WORK, 'batch-accept.json'), specBefore = hash(spec);
    bad(['render', '--batch', pattern, '--out', renderDir, '--accept', spec, '--manifest', spec], /acceptance spec/);
    assert.equal(hash(spec), specBefore);
    const unrelated = join(WORK, 'other-config.json'); writeFileSync(unrelated, '{"keep":true}');
    bad(['render', '--batch', pattern, '--out', renderDir, '--manifest', unrelated], /unsupported batch manifest/);
    assert.equal(readFileSync(unrelated, 'utf8'), '{"keep":true}');
  });
  check('Poly Haven discovery filters, ranks, limits and reports cache use', () => {
    const root = join(WORK, 'cache'); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'polyhaven-index-all.json'), JSON.stringify({ fetched_at: Date.now(), data: {
      wood: { name: 'Wood', type: 1, categories: ['wood'], tags: [] },
      wooden_table: { name: 'Wooden Table', type: 2, categories: ['furniture'], tags: ['wood'] },
      sky: { name: 'Sky', type: 0, categories: ['outdoor'], tags: [] },
    } }));
    const r = good(['assets', 'search', 'wood', '--category', 'furniture', '--limit', '1']);
    assert.equal(r.cached, true); assert.equal(r.assets[0].import, 'polyhaven:wooden_table');
    assert.equal(r.assets[0].license, 'CC0'); assert.equal(r.returned, 1);
    bad(['assets', 'search', '--limit', '0'], /limit/);
  });
  check('unknown commands and invalid resume requests keep the JSON error contract', () => {
    bad(['not-a-command'], /Unknown command/);
    bad(['render', '--blend', SOURCE, '--resume'], /require --batch/);
    bad(['render', '--batch', pattern, '--out', renderDir, '--resume'], /requires --manifest/);
  });
} catch (e) { failed++; console.log(`  FAIL  fixture setup — ${e.message}`); }
finally { rmSync(WORK, { recursive: true, force: true }); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
