import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Next compiles TypeScript configuration through a temporary
// next.config.compiled.js. import.meta.url points at that transient file, which
// has already been removed by the time the exported config runs on Windows.
const projectRoot = process.cwd();
const configFilePath = resolve(projectRoot, 'next.config.ts');
const configRevision = createHash('sha256').update(readFileSync(configFilePath)).digest('hex');
const configuredBasePath = String(process.env.WEBPILOT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
const basePath = configuredBasePath ? `/${configuredBasePath}` : '';
const serverRole = process.env.WEBPILOT_SERVER_ROLE === 'runtime' ? 'runtime' : 'ui';
const capabilitySource = process.env.WEBPILOT_CAPABILITY_SOURCE === 'npm' ? 'npm' : 'workspace';

export default function nextConfig(phase: string): NextConfig {
  return {
    basePath,
    typescript: {
      tsconfigPath: capabilitySource === 'npm' ? 'tsconfig.npm.json' : 'tsconfig.json',
    },
    transpilePackages: [
      '@webpilot/capability-sdk',
      '@webpilot/capability-adapter-ai-sdk',
      '@webpilot/capability-adapter-mcp',
      '@webpilot/capability-browser',
      '@webpilot/capability-chart',
      '@webpilot/capability-file',
    ],
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
    webpack(config, { dev }) {
      if (dev && process.env.WEBPILOT_DEBUG_WEBPACK_CACHE === '1') {
        config.infrastructureLogging = {
          ...(config.infrastructureLogging || {}),
          debug: /PackFileCacheStrategy/,
          level: 'verbose',
        };
      }
      if (capabilitySource === 'workspace') {
        // Capability packages keep explicit .js specifiers for their published
        // ESM output. During local development those specifiers point at the
        // TypeScript workspace sources, so Webpack must resolve the source
        // extension before falling back to the emitted extension.
        config.resolve.extensionAlias = {
          ...(config.resolve.extensionAlias || {}),
          '.js': ['.ts', '.tsx', '.js'],
          '.jsx': ['.tsx', '.jsx'],
          '.mjs': ['.mts', '.mjs'],
          '.cjs': ['.cts', '.cjs'],
        };
      }
      if (dev && config.cache && typeof config.cache === 'object' && config.cache.type === 'filesystem') {
        // The browser-chat UI produces very large persistent cache packs. Copy
        // deserialized slices into right-sized buffers so a small cached value
        // cannot keep an entire decompressed pack alive in the Node heap. Purge
        // inactive entries through Next's development memory cache policy.
        config.cache.allowCollectingMemory = true;
        // The Windows snapshotter can walk above this workspace while resolving
        // next.config and try to open the user-profile directory as a file
        // (EPERM), silently disabling the entire persistent cache. This exact
        // content hash provides invalidation without that broken snapshot.
        config.cache.version = `${config.cache.version || ''}|webpilot:${configRevision}`;
        config.cache.buildDependencies = {
          ...(config.cache.buildDependencies || {}),
          config: [],
        };
      }
      return config;
    },
    serverExternalPackages: [
      'typeorm',
      'better-sqlite3',
      'pg',
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
