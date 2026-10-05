// Backend dev loop: incremental tsc into dist/ plus node --watch on the output.
// Spawned without a shell so it behaves the same on macOS, Linux and Windows.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
const args = process.argv.slice(2);

const children = [];
function run(cmd, cmdArgs) {
  const child = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  children.push(child);
  return child;
}

// One synchronous build first so node --watch has an entry point.
const first = spawn(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
first.on('exit', (code) => {
  if (code !== 0 || !existsSync(join(root, 'dist/main.js'))) {
    console.error('Initial backend build failed.');
    process.exit(code ?? 1);
  }
  run(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput']);
  run(process.execPath, ['--watch-path=dist', '--enable-source-maps', 'dist/main.js', ...args]);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(0);
  });
}
