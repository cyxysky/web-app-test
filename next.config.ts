import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const configuredBasePath = String(process.env.WEBPILOT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
const basePath = configuredBasePath ? `/${configuredBasePath}` : '';

const nextConfig: NextConfig = {
  basePath,
  env: {
    NEXT_PUBLIC_WEBPILOT_BASE_PATH: basePath,
  },
  output: 'standalone',
  outputFileTracingIncludes: {
    '/*': [
      './node_modules/ffmpeg-static/ffmpeg*',
      './node_modules/ffmpeg-static/package.json',
    ],
  },
  outputFileTracingRoot: currentDir,
  eslint: {
    ignoreDuringBuilds: true,
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

export default nextConfig;
