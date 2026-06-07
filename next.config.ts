import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: currentDir,
  serverExternalPackages: [
    'playwright',
    'ai-sdk-provider-gemini-cli',
    '@google/gemini-cli-core',
    'tree-sitter-bash',
    'web-tree-sitter',
  ],
};

export default nextConfig;
