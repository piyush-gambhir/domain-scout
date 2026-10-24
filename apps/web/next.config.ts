import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Monorepo root: workspace packages (contracts, api-client) live outside apps/web.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const nextConfig: NextConfig = {
  experimental: { agentUpgrade: 'security' },
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  // No remote or optimized images: keeps the native `sharp` module out of the portable server bundle.
  images: { unoptimized: true },
  // Loopback only: compression buys nothing and would buffer the SSE stream.
  compress: false,
  devIndicators: false,
  // Repo-level AGENTS.md is the source of agent instructions; do not generate per-app copies.
  agentRules: false,
  // Pages of the first UI moved into task-based destinations. Old links and bookmarks keep working;
  // query strings (?job=, ?criteria=, ?d=, ?p=) pass through.
  async redirects() {
    const moved: [string, string][] = [
      ['/scan', '/'],
      ['/discover', '/?mode=ideas'],
      ['/jobs', '/history'],
      ['/jobs/:id', '/search/:id'],
      ['/collections', '/saved'],
      ['/collections/:id', '/saved/:id'],
      ['/compare', '/saved'],
      ['/monitoring', '/watching'],
      ['/monitoring/:id', '/watching/:id'],
      ['/providers', '/settings/providers'],
    ];
    return moved.map(([source, destination]) => ({ source, destination, permanent: false }));
  },
};

export default nextConfig;
