# syntax=docker/dockerfile:1.7
# Local single-container image: backend (loopback inside the container) + web UI + Go CLI.
# Run with `docker compose up --build`; see compose.yaml.

# Base images are pinned by digest, which Dependabot refreshes. Change the Node and Go versions by hand,
# together with .nvmrc and the toolchain in apps/cli/go.mod.
FROM golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS cli
WORKDIR /src/apps/cli
COPY apps/cli/go.mod apps/cli/go.sum ./
RUN go mod download
COPY apps/cli/ ./
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/domain-scout ./cmd/domain-scout

FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS build
ENV CI=1 NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
# Verify the native package-manager artifact for each supported build platform.
RUN node --input-type=module -e 'import { createHash } from "node:crypto"; import { writeFileSync } from "node:fs"; const hashes = { x64: "yc+QlZR+9+nr29J4fRzhMoapgxTBDndq/+peyoq1XUufnQFnfbXUMFudDIKzHi545linGqmOmXfn0NoufNgcOg==", arm64: "qML/8aCXslh8td/w4U+HJNqUcZ2+m6EfTbWScIzZRmyPsRFN+xB4LP1U/hymxc1iSJiKtG56HJx2fvUErWFIGw==" }; const hash = hashes[process.arch]; if (!hash) throw new Error("Unsupported pnpm build platform"); const response = await fetch(`https://registry.npmjs.org/@pnpm/exe.linux-${process.arch}/-/exe.linux-${process.arch}-12.15.0.tgz`); if (!response.ok) throw new Error("pnpm download failed"); const bytes = Buffer.from(await response.arrayBuffer()); if (createHash("sha512").update(bytes).digest("base64") !== hash) throw new Error("pnpm integrity mismatch"); writeFileSync("/tmp/pnpm.tgz", bytes);' \
 && mkdir -p /opt/pnpm \
 && tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/pnpm \
 && ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm \
 && rm /tmp/pnpm.tgz
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/api-client/package.json packages/api-client/
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@domain-scout/backend --filter=@domain-scout/web
RUN pnpm --filter @domain-scout/backend deploy --prod --legacy /out/backend \
 && mkdir -p /out/web \
 && cp -R apps/web/.next/standalone/. /out/web/ \
 && cp -R apps/web/.next/static /out/web/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -R apps/web/public /out/web/apps/web/public; fi \
 && printf "import './apps/web/server.js';\n" > /out/web/server.js \
 && printf '{ "private": true, "type": "module" }\n' > /out/web/package.json

FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DOMAIN_SCOUT_DATA_DIR=/data \
    PATH=/opt/domain-scout/bin:$PATH
WORKDIR /opt/domain-scout
COPY --from=build /out/backend lib/backend
COPY --from=build /out/web lib/web
COPY --from=cli /out/domain-scout bin/domain-scout
COPY scripts/container-start.mjs container-start.mjs
RUN printf '#!/bin/sh\nexec node /opt/domain-scout/container-start.mjs --print-url\n' > bin/open-url \
 && chmod 0755 bin/open-url \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4317/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/domain-scout/container-start.mjs"]
