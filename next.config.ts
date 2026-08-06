import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const configuredBasePath = String(process.env.WEBPILOT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
const basePath = configuredBasePath ? `/${configuredBasePath}` : '';

export default function nextConfig(phase: string): NextConfig {
  return {
    basePath,
    // A running development server must never write into the production build
    // directory. Sharing .next lets dev hot updates corrupt next build manifests.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    env: {
      NEXT_PUBLIC_WEBPILOT_BASE_PATH: basePath,
    },
    // Do not let Turbopack walk out to an unrelated package-lock.json in a
    // parent directory (for example, the Windows user profile directory).
    turbopack: {
      root: projectRoot,
    },
    serverExternalPackages: [
      'playwright',
      'docx',
      'pdfkit',
      'pptxgenjs',
      'pdf-parse',
      'ai-sdk-provider-gemini-cli',
      '@google/gemini-cli-core',
      'tree-sitter-bash',
      'web-tree-sitter',
      'ffmpeg-static',
    ],
  };
}
