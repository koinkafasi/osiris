import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Pin the workspace root to this project — without this, Next.js
  // auto-detects a "workspace root" by walking up for lockfiles and
  // picks up an unrelated ~/package-lock.json in the home directory,
  // causing its build-time file tracer to scan (and fail on
  // permission-restricted files in) unrelated directories like
  // ~/traefik/dynamic/.
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['ws'],
  transpilePackages: ['react-map-gl', 'mapbox-gl', 'maplibre-gl'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: wss: data: blob:;" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
        ],
      },
    ];
  },
};

export default nextConfig;
