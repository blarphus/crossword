const { spawnSync } = require('child_process');
const assert = require('assert');

const tests = [
  'tests/stage1-dead-code.js',
  'tests/stage2-client-shell.js',
  'tests/stage3-client-runtime.js',
  'tests/stage4-private-room-service.js',
  'tests/stage5-db-split.js',
];

for (const test of tests) {
  const result = spawnSync(process.execPath, [test], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.strictEqual(result.status, 0, `${test} failed`);
}

console.log('stage6 ok');
