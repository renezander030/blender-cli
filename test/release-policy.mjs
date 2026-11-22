import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const gateMatch = workflow.match(/          script: \|\n((?:            .*\n)+)/);
assert.ok(gateMatch, 'release review gate script must exist');
const gate = new (Object.getPrototypeOf(async function() {}).constructor)('context', 'github', 'core', gateMatch[1].replace(/^            /gm, ''));
const owner = 'fixture-owner', sha = 'a'.repeat(40);
// a pushed v tag publishes only a commit that passed the Blender conformance suite on master
async function decision(runs, ref = 'refs/tags/v0.7.0') {
  const outputs = {}, asked = [];
  let failed = '';
  await gate({ repo: { owner, repo: 'fixture-repo' }, sha, ref },
    { rest: { actions: { listWorkflowRuns: async (q) => { asked.push(q); return { data: { workflow_runs: runs } }; } } } },
    { setOutput: (k, v) => { outputs[k] = v; }, setFailed: (m) => { failed = m; }, notice: () => {} });
  return { outputs, failed, asked };
}
const passed = await decision([{ id: 1, head_sha: sha, conclusion: 'success' }]);
assert.deepEqual(passed.outputs, { approved: 'true', version: '0.7.0' });
assert.equal(passed.failed, '');
assert.deepEqual(passed.asked[0], { owner, repo: 'fixture-repo', workflow_id: 'ci.yml', head_sha: sha, event: 'push', branch: 'master', status: 'success' });
const untested = await decision([]);
assert.equal(untested.outputs.approved, 'false');
assert.match(untested.failed, /No successful Blender conformance run on master/);
const blocks = [...workflow.matchAll(/          node --input-type=module <<'JS'\n([\s\S]*?)\n          JS/g)].map(m => m[1].replace(/^          /gm, ''));
assert.equal(blocks.length, 3, 'expected prepare, package metadata and registry-conflict scripts');
const work = mkdtempSync(join(tmpdir(), 'bcli-release-policy-'));
function run(code, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: work, encoding: 'utf8', env: { ...process.env, RELEASE_VERSION: '0.7.0', ...env },
  });
}
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'blender-cli', version: '0.7.0' }));
  writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\n## 0.7.0 (unreleased)\n\n- New behavior.\n\n## 0.6.0 (released)\n\n- Old behavior.\n');
  assert.equal(run(blocks[0]).status, 0);
  const notes = readFileSync(join(work, 'release-notes.txt'), 'utf8');
  assert.match(notes, /New behavior/); assert.doesNotMatch(notes, /Old behavior|unreleased/);
  assert.notEqual(run(blocks[0], { RELEASE_VERSION: '0.8.0' }).status, 0);
  const integrity = 'sha512-fixture';
  for (const [status, existing, shouldPass, shouldSkip] of [[404, null, true, false],
    [200, integrity, true, true], [200, 'sha512-different', false, false], [500, null, false, false]]) {
    rmSync(join(work, 'already-published'), { force: true });
    const stub = `globalThis.fetch = async () => ({ status: ${status}, ok: ${status === 200}, json: async () => ({ dist: { integrity: ${JSON.stringify(existing)} } }) });\n`;
    const result = run(stub + blocks[2], { RELEASE_INTEGRITY: integrity });
    assert.equal(result.status === 0, shouldPass, result.stderr);
    assert.equal(existsSync(join(work, 'already-published')), shouldSkip);
  }
} finally { rmSync(work, { recursive: true, force: true }); }
console.log('Release publishing policy: tested-tag check, version matching and registry conflict checks passed.');
