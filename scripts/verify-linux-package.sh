#!/usr/bin/env bash
# Runs a packaged Linux archive inside a plain node:26 container and checks the CLI launcher, the
# browser sign-in flow, the API through the web server, owner-only permissions and a clean stop.
# No names leave the container. Usage: scripts/verify-linux-package.sh [arm64|amd64]
set -euo pipefail
arch="${1:-arm64}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$repo/apps/backend/package.json').version")"
archive="domain-scout-${version}-linux-${arch}"
[ -f "$repo/release/${archive}.tar.gz" ] || { echo "Missing release/${archive}.tar.gz; run pnpm package" >&2; exit 1; }

docker run --rm --platform "linux/${arch}" -v "$repo/release:/release:ro" -e ARCHIVE="$archive" node:26-bookworm-slim bash -euo pipefail -c '
mkdir -p /opt/test && tar -xzf "/release/${ARCHIVE}.tar.gz" -C /opt/test
cd "/opt/test/${ARCHIVE}"
export DOMAIN_SCOUT_DATA_DIR=/tmp/ds-data
./bin/domain-scout version
url=$(./bin/domain-scout ui --no-open 2>&1 | grep -oE "http://[^ ]+/auth/bootstrap\?code=[^ ]+")
node -e "
const url = process.argv[1];
(async () => {
  const boot = await fetch(url, { redirect: \"manual\" });
  const cookie = boot.headers.getSetCookie().map((c) => c.split(\";\")[0]).join(\"; \");
  const scan = await fetch(\"http://127.0.0.1:3000/scan\", { headers: { cookie } });
  const cov = await fetch(\"http://127.0.0.1:3000/api/v1/coverage/summary\", { headers: { cookie } });
  const ok = boot.status === 303 && scan.status === 200 && cov.status === 200;
  console.log(ok ? \"PASS ui, session and api\" : \"FAIL ui, session or api\");
  process.exit(ok ? 0 : 1);
})();" "$url"
modes=$(stat -c "%a" /tmp/ds-data /tmp/ds-data/run /tmp/ds-data/run/api-token | tr "\n" " ")
[ "$modes" = "700 700 600 " ] && echo "PASS owner-only permissions" || { echo "FAIL permissions: $modes"; exit 1; }
./bin/domain-scout service stop >/dev/null && echo "PASS service stop"
'
