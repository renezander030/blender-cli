import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const file of ['release-policy.mjs', 'smoke.mjs', 'release.mjs', 'v080.mjs']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
