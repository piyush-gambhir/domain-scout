// Builds the CLI-only npm distribution in release/npm: a `domain-scout` package holding the backend
// (with its production dependencies bundled, so installs run the tested versions) and a launcher
// script, plus one package per platform holding the Go CLI. The web UI is not included; release
// archives (scripts/package.mjs), Docker and a repository checkout carry it.
// Packages stay `private` until a publishing decision: install them from the packed tarballs.
// Requires `pnpm build` first. Usage: node scripts/package-npm.mjs [--target darwin-arm64,linux-x64,...]
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(repo, 'release', 'npm');
const version = JSON.parse(readFileSync(join(repo, 'apps/backend/package.json'), 'utf8')).version;
const NODE_RANGE = '>=24.11';
/** Package names are placeholders until publishing is decided; a scope prevents resolving someone else's package. */
const MAIN = 'domain-scout';
const platformPackage = (target) => `@domain-scout/cli-${target}`;

// Node platform-arch -> Go GOOS/GOARCH.
const TARGETS = {
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-x64': ['darwin', 'amd64'],
  'linux-arm64': ['linux', 'arm64'],
  'linux-x64': ['linux', 'amd64'],
  'win32-x64': ['windows', 'amd64'],
};
const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];
const targets = targetArg ? targetArg.split(',') : Object.keys(TARGETS);
for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; expected ${Object.keys(TARGETS).join(', ')}`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
// Windows runs the npm and pnpm .cmd shims only through a shell (Node refuses them otherwise),
// so arguments are quoted for cmd.exe there.
const win = process.platform === 'win32';
const quote = (arg) => (win && /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
const runTool = (name, args, opts = {}) => run(win ? `${name}.cmd` : name, win ? args.map(quote) : args, { shell: win, ...opts });
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (!existsSync(join(repo, 'apps/backend/dist/main.js'))) {
  console.error('Missing apps/backend/dist/main.js. Run `pnpm build` first.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Main package: the deployed backend at the package root (dist/, data/, a flat node_modules).
const main = join(out, 'domain-scout');
// Real copies, not hard links into pnpm's store: npm pack never finishes on a tree whose files share
// inodes (pnpm hard-links on Linux and Windows; macOS clones, which is why it worked there).
runTool('pnpm', ['--filter', '@domain-scout/backend', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', '--config.package-import-method=copy', main]);
rmSync(join(main, 'node_modules/.bin'), { recursive: true, force: true });
// `deploy --prod` also prunes dev dependencies from the workspace's own node_modules; restore them.
runTool('pnpm', ['install', '--frozen-lockfile', '--offline']);

const deployed = JSON.parse(readFileSync(join(main, 'package.json'), 'utf8'));
// Every dependency ships inside the tarball: npm never resolves them, so the lockfile's versions
// (and pnpm overrides such as the multer fix) are what runs.
const dependencies = Object.fromEntries(
  readdirSync(join(main, 'node_modules'))
    .flatMap((name) => (name.startsWith('@') ? readdirSync(join(main, 'node_modules', name)).map((sub) => `${name}/${sub}`) : [name]))
    .filter((name) => !name.startsWith('.'))
    .map((name) => [name, JSON.parse(readFileSync(join(main, 'node_modules', name, 'package.json'), 'utf8')).version]),
);
for (const name of Object.keys(deployed.dependencies ?? {})) {
  if (!dependencies[name]) throw new Error(`deployed dependency ${name} is missing from node_modules`);
}
writeFileSync(
  join(main, 'package.json'),
  json({
    name: MAIN,
    version,
    private: true,
    description: 'Domain availability, registry evidence and pricing research for coding agents. CLI with a local engine; no hosted service.',
    type: 'module',
    bin: { 'domain-scout': 'bin/domain-scout.js' },
    engines: { node: NODE_RANGE },
    files: ['bin', 'dist', 'data'],
    dependencies,
    bundleDependencies: Object.keys(dependencies),
    optionalDependencies: Object.fromEntries(Object.keys(TARGETS).map((t) => [platformPackage(t), version])),
  }),
);

mkdirSync(join(main, 'bin'), { recursive: true });
const platforms = Object.fromEntries(Object.keys(TARGETS).map((t) => [t, platformPackage(t)]));
writeFileSync(
  join(main, 'bin', 'domain-scout.js'),
  `#!/usr/bin/env node
// Runs this platform's Go CLI with this package's backend and this Node.js, so the npm install is
// the whole setup. Arguments, stdio (including MCP over stdin/stdout) and the exit status pass through.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = ${JSON.stringify(platforms, null, 2)};
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

function fail(message) {
  process.stderr.write(\`domain-scout: \${message}\\n\`);
  process.exit(5);
}

const key = \`\${process.platform}-\${process.arch}\`;
let binary = process.env.DOMAIN_SCOUT_BINARY;
if (!binary) {
  const pkg = PLATFORMS[key];
  if (!pkg) fail(\`no CLI build for \${key}. Supported: \${Object.keys(PLATFORMS).join(', ')}.\`);
  try {
    binary = join(dirname(require.resolve(\`\${pkg}/package.json\`)), 'bin', process.platform === 'win32' ? 'domain-scout.exe' : 'domain-scout');
  } catch {
    fail(\`\${pkg} is not installed. Reinstall without --omit=optional (or --no-optional) so npm adds this platform's CLI.\`);
  }
}

const child = spawn(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    DOMAIN_SCOUT_NODE: process.env.DOMAIN_SCOUT_NODE || process.execPath,
    DOMAIN_SCOUT_BACKEND_ENTRY: process.env.DOMAIN_SCOUT_BACKEND_ENTRY || join(root, 'dist', 'main.js'),
  },
});
// Ctrl-C already reaches the CLI (same process group): stay alive until it exits. A termination
// aimed at this process alone, e.g. an agent stopping its MCP server, is passed on.
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => fail(\`cannot run \${binary}: \${error.message}\`));
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`,
);
chmodSync(join(main, 'bin', 'domain-scout.js'), 0o755);
writeFileSync(
  join(main, 'README.md'),
  `# Domain Scout ${version}

Domain availability, registry evidence and pricing research for coding agents. Node.js ${NODE_RANGE.slice(2)} or newer.

\`\`\`sh
domain-scout scan acme --tlds com,io,dev --wait   # registry checks; JSON on stdout
domain-scout jobs list
domain-scout mcp                                  # MCP server over stdio
domain-scout --help
\`\`\`

The first command starts a local engine in the background; it stops itself after ten idle minutes
(DOMAIN_SCOUT_IDLE_TIMEOUT, in seconds, 0 to keep it running) unless watches are active.
Data stays in the per-user application data directory. This package has no web UI.
`,
);

// Platform packages: just the Go binary.
for (const target of targets) {
  const [goos, goarch] = TARGETS[target];
  const [os, cpu] = target.split('-');
  const dir = join(out, `cli-${target}`);
  const exe = goos === 'windows' ? 'domain-scout.exe' : 'domain-scout';
  mkdirSync(join(dir, 'bin'), { recursive: true });
  run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', join(dir, 'bin', exe), './cmd/domain-scout'], {
    cwd: join(repo, 'apps/cli'),
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  });
  writeFileSync(
    join(dir, 'package.json'),
    json({ name: platformPackage(target), version, private: true, description: `Domain Scout CLI for ${target}`, os: [os], cpu: [cpu], files: ['bin'] }),
  );
}

for (const dir of ['domain-scout', ...targets.map((t) => `cli-${t}`)]) {
  runTool('npm', ['pack', '--pack-destination', out, '--loglevel', 'warn'], { cwd: join(out, dir) });
}
for (const file of readdirSync(out).filter((f) => f.endsWith('.tgz'))) {
  console.log(`${file}  ${(statSync(join(out, file)).size / 1e6).toFixed(1)} MB`);
}
