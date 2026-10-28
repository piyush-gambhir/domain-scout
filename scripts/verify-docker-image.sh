#!/usr/bin/env bash
# Builds the Docker image and runs it the way compose.yaml does, on a spare loopback port with its
# own volume, then checks the sign-in link, the UI and the API through the web server, the health
# check and a graceful stop. Removes the container, volume and image afterwards. Sends no names.
# Usage: scripts/verify-docker-image.sh [host-port]
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${1:-3917}"
id="ds-verify-$$"
tag="domain-scout:$id"
cleanup() {
  docker rm -f "$id" >/dev/null 2>&1 || true
  docker volume rm "$id" >/dev/null 2>&1 || true
  docker image rm "$tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -q -t "$tag" "$repo" >/dev/null
echo "PASS image builds"
docker run -d --name "$id" --init -e DOMAIN_SCOUT_PUBLIC_PORT="$port" -p "127.0.0.1:$port:3000" -v "$id:/data" "$tag" >/dev/null

url=""
for _ in $(seq 1 90); do
  url="$(docker logs "$id" 2>&1 | grep -oE "http://localhost:$port/auth/bootstrap\?code=[^ ]+" | head -n 1 || true)"
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { echo "FAIL no sign-in link in the logs"; docker logs "$id" 2>&1 | tail -n 30; exit 1; }
echo "PASS sign-in link in the logs"

node -e '
const [url, port] = process.argv.slice(1);
(async () => {
  const boot = await fetch(url, { redirect: "manual" });
  const cookie = boot.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const page = await fetch(`http://localhost:${port}/scan`, { headers: { cookie } });
  const api = await fetch(`http://localhost:${port}/api/v1/coverage/summary`, { headers: { cookie } });
  const ok = boot.status === 303 && page.status === 200 && api.status === 200;
  console.log(`${ok ? "PASS" : "FAIL"} browser sign-in, UI page and API through the web server (${boot.status} ${page.status} ${api.status})`);
  process.exit(ok ? 0 : 1);
})();' "$url" "$port"

status=starting
for _ in $(seq 1 40); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$id")"
  [ "$status" != starting ] && break
  sleep 3
done
[ "$status" = healthy ] || { echo "FAIL health check: $status"; exit 1; }
echo "PASS health check"

docker stop "$id" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$id")"
[ "$code" = 0 ] || { echo "FAIL stop exited $code"; exit 1; }
echo "PASS graceful stop"
