import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';


const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const nextConfig: NextConfig = {
  experimental: { agentUpgrade: 'security' },
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,

  images: { unoptimized: true },

  compress: false,
  devIndicators: false,

  agentRules: false,


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
