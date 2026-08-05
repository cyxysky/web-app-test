import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    '.next/**',
    '.next-dev/**',
    'artifacts/**',
    'dist-desktop/**',
    'dist-electron/**',
    'dist-server/**',
    'electron/**',
    'next-env.d.ts',
    'node_modules/**',
    'scripts/electron-after-pack.js',
    'scripts/package-server.js',
    'scripts/prepare-electron-server.js',
    'scripts/__pycache__/**',
  ]),
  {
    rules: {
      '@next/next/no-img-element': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);

export default eslintConfig;
