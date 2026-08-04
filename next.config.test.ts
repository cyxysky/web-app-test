import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';
import nextConfig from './next.config';

test('isolates development output from production build output', () => {
  assert.equal(nextConfig(PHASE_DEVELOPMENT_SERVER).distDir, '.next-dev');
  assert.equal(nextConfig(PHASE_PRODUCTION_BUILD).distDir, '.next');
});
