import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Monorepo root: workspace packages (contracts, api-client) live outside apps/web.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  // Loopback only: compression buys nothing and would buffer the SSE stream.
  compress: false,
  devIndicators: false,
  // Repo-level AGENTS.md is the source of agent instructions; do not generate per-app copies.
  agentRules: false,
};

export default nextConfig;
