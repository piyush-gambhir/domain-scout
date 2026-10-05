// Builds local distribution archives: Go CLI per target plus the platform-independent backend
// and web payloads (no native modules: SQLite comes from node:sqlite). Requires `pnpm build` first.
// Usage: node scripts/package.mjs [--target darwin-arm64,linux-amd64,...]
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(repo, 'release');
const version = JSON.parse(readFileSync(join(repo, 'apps/backend/package.json'), 'utf8')).version;
const contracts = await import(join(repo, 'packages/contracts/dist/index.js'));

const ALL_TARGETS = ['darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64', 'windows-amd64'];
const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];
const targets = targetArg ? targetArg.split(',') : ALL_TARGETS;

/**
 * Copies a tree replacing every symlink with what it points at (fs.cpSync's `dereference` only
 * applies to the top-level source). Next's standalone output links into pnpm's store.
 */
function copyResolved(src, dest) {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) copyResolved(join(src, entry), join(dest, entry));
  } else {
    copyFileSync(src, dest);
  }
}

/**
 * Turns Next's pnpm-shaped standalone output into a flat, symlink-free tree: app files are copied
 * as they are and every package from the .pnpm store is hoisted into <out>/node_modules. Native
 * image packages (sharp) are left out; the app uses unoptimized images, so it never loads them.
 */
function flattenStandalone(standalone, out) {
  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(standalone)) {
    if (entry === 'node_modules') continue;
    copySkippingNodeModules(join(standalone, entry), join(out, entry));
  }
  const store = join(standalone, 'node_modules/.pnpm');
  const ids = readdirSync(store).filter((id) => id !== 'node_modules' && !/^(sharp@|@img\+)/.test(id));
  // Natural sort so a newer version of a duplicated package (e.g. semver 7 over 6) is copied last.
  ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const id of ids) {
    const modules = join(store, id, 'node_modules');
    for (const name of packageNames(modules)) {
      if (lstatSync(join(modules, name)).isSymbolicLink()) continue;
      const target = join(out, 'node_modules', name);
      rmSync(target, { recursive: true, force: true });
      copyResolved(join(modules, name), target);
    }
  }
}

function packageNames(modules) {
  return readdirSync(modules).flatMap((name) =>
    name.startsWith('@') ? readdirSync(join(modules, name)).map((sub) => `${name}/${sub}`) : [name],
  );
}

function copySkippingNodeModules(src, dest) {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (src.endsWith('node_modules')) return;
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) copySkippingNodeModules(join(src, entry), join(dest, entry));
  } else {
    copyFileSync(src, dest);
  }
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

for (const required of ['apps/backend/dist/main.js', 'apps/web/.next/standalone']) {
  if (!existsSync(join(repo, required))) {
    console.error(`Missing ${required}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Shared payloads, built once.
const payload = join(out, '.payload');
const backendDir = join(payload, 'backend');
// Hoisted layout: a flat node_modules with real directories, so archives extract the same on every
// OS (Windows tar cannot always create symlinks) and never point back at this build machine.
run(pnpm, ['--filter', '@domain-scout/backend', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', backendDir]);
rmSync(join(backendDir, 'node_modules/.bin'), { recursive: true, force: true });
// `deploy --prod` also prunes dev dependencies from the workspace's own node_modules; restore them.
run(pnpm, ['install', '--frozen-lockfile', '--offline']);

const webDir = join(payload, 'web');
flattenStandalone(join(repo, 'apps/web/.next/standalone'), webDir);
cpSync(join(repo, 'apps/web/.next/static'), join(webDir, 'apps/web/.next/static'), { recursive: true });
if (existsSync(join(repo, 'apps/web/public'))) {
  cpSync(join(repo, 'apps/web/public'), join(webDir, 'apps/web/public'), { recursive: true });
}
// Stable entry point for the CLI launcher: <lib>/web/server.js.
// Next emits an ESM server.js because apps/web is an ES module package.
writeFileSync(join(webDir, 'server.js'), "import './apps/web/server.js';\n");
writeFileSync(join(webDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));

for (const target of targets) {
  const [os, arch] = target.split('-');
  const name = `domain-scout-${version}-${target}`;
  const dir = join(out, name);
  const exe = os === 'windows' ? 'domain-scout.exe' : 'domain-scout';
  mkdirSync(join(dir, 'bin'), { recursive: true });
  run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', join(dir, 'bin', exe), './cmd/domain-scout'], {
    cwd: join(repo, 'apps/cli'),
    env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' },
  });
  cpSync(backendDir, join(dir, 'lib/backend'), { recursive: true });
  cpSync(webDir, join(dir, 'lib/web'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'domain-scout',
        version,
        contractVersion: contracts.CONTRACT_VERSION,
        protocolVersion: contracts.PROTOCOL_VERSION,
        os,
        arch,
        node: '>=24.11',
        layout: { cli: `bin/${exe}`, backend: 'lib/backend/dist/main.js', web: 'lib/web/server.js' },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'README.txt'),
    `Domain Scout ${version} (${target})\n\nRequires Node.js 24.11 or newer on PATH (or DOMAIN_SCOUT_NODE).\n\n  bin/${exe} ui              open the web UI\n  bin/${exe} scan acme --tlds com,io --wait\n  bin/${exe} service stop\n`,
  );
  // macOS tar would otherwise embed Apple extended attributes that other platforms warn about.
  const macTar = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : [];
  run('tar', [...macTar, '-czf', `${name}.tar.gz`, name], { cwd: out, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  console.log(`packaged ${name}.tar.gz`);
}

rmSync(payload, { recursive: true, force: true });
