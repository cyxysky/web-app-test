import type { CapabilityManifest } from '@webpilot/capability-sdk';
import { sensitiveDataCapabilitySettings } from './settings.js';

export * from './client.js';
export * from './config.js';
export * from './settings.js';

export const sensitiveDataCapabilityManifest = Object.freeze({
  schemaVersion: 1,
  id: 'com.webpilot.sensitive-data',
  name: 'Sensitive data filtering',
  version: '0.1.0',
  description: 'Provider-boundary sensitive-data redaction with an optional managed GLiNER runtime.',
  permissions: ['model:prompt:transform', 'network:loopback'],
  runtimeRequirements: { node: '>=22.16', python: '>=3.10' },
  configuration: { settings: sensitiveDataCapabilitySettings },
} satisfies CapabilityManifest);
