import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: [
      '.next/**',
      'artifacts/**',
      'dist-desktop/**',
      'dist-electron/**',
      'electron/**',
      'next-env.d.ts',
      'node_modules/**',
      'scripts/electron-after-pack.js',
      'scripts/prepare-electron-server.js',
      'scripts/__pycache__/**',
    ],
  },
  {
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
];

export default eslintConfig;
