import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const configuredBasePath = String(process.env.WEBPILOT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
const basePath = configuredBasePath ? `/${configuredBasePath}` : '';
const serverRole = process.env.WEBPILOT_SERVER_ROLE === 'runtime' ? 'runtime' : 'ui';

export default function nextConfig(phase: string): NextConfig {
  return {
    basePath,
    // A running development server must never write into the production build
    // directory. Sharing .next lets dev hot updates corrupt next build manifests.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? `.next-dev-${serverRole}` : '.next',
    env: {
      NEXT_PUBLIC_WEBPILOT_BASE_PATH: basePath,
    },
    // Do not let Turbopack walk out to an unrelated package-lock.json in a
    // parent directory (for example, the Windows user profile directory).
    turbopack: {
      root: projectRoot,
    },
    experimental: {
      // Keep the Webpack fallback/build path at a lower peak, and avoid eagerly
      // loading every route into the long-lived server process.
      webpackMemoryOptimizations: true,
      preloadEntriesOnStart: false,
    },
    serverExternalPackages: [
      'playwright',
      'pdf-parse',
      'ai-sdk-provider-gemini-cli',
      '@google/gemini-cli-core',
      'tree-sitter-bash',
      'web-tree-sitter',
      'ffmpeg-static',
    ],
  };
}
