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
const approved = { number: 4, merged_at: '2026-10-03T00:00:00Z', merge_commit_sha: sha,
  base: { ref: 'master' }, merged_by: { login: owner }, head: { ref: 'release/v0.7.0' } };
async function decision(prs) {
  const outputs = {};
  await gate({ repo: { owner, repo: 'fixture-repo' }, payload: { workflow_run: { head_sha: sha } } },
    { rest: { repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: prs }) },
      pulls: { get: async ({ pull_number }) => ({ data: prs.find(p => p.number === pull_number) }) } } },
    { setOutput: (k, v) => { outputs[k] = v; }, notice: () => {} });
  return outputs;
}
assert.deepEqual(await decision([approved]), { approved: 'true', version: '0.7.0' });
for (const prs of [[], [{ ...approved, merged_at: null }], [{ ...approved, merged_by: { login: 'another-user' } }],
  [{ ...approved, merge_commit_sha: 'b'.repeat(40) }], [{ ...approved, base: { ref: 'development' } }],
  [{ ...approved, head: { ref: 'feature/new-work' } }]]) assert.equal((await decision(prs)).approved, 'false');
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
console.log('Release publishing policy: owner/commit/branch checks, version matching and registry conflict checks passed.');
