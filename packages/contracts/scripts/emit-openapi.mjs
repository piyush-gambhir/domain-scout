// Writes openapi.json from the compiled contracts. `--check` fails when the committed file drifts.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../dist/index.js';

const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
const next = JSON.stringify(buildOpenApiDocument(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  if (current !== next) {
    console.error('openapi.json is out of date. Run `pnpm generate`.');
    process.exit(1);
  }
} else {
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}
