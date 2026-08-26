import { describe, expect, it } from 'vitest';
import {
  environmentSettingsTabs,
  isAdministratorOnlySettingsTab,
} from '../components/environment-settings-model';
import { normalizeRuntimeEnvValue, runtimeEnvDefinitions } from './settings';

const sensitiveDataSettingKeys = [
  'AI_SENSITIVE_DATA_FILTER_ENABLED',
  'GLINER_SERVICE_URL',
  'AI_SENSITIVE_DATA_FILTER_FAILURE_MODE',
  'AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS',
  'AI_SENSITIVE_DATA_FILTER_THRESHOLD',
  'AI_SENSITIVE_DATA_FILTER_LABELS',
  'GLINER_MODEL',
  'GLINER_DEVICE',
  'GLINER_BATCH_SIZE',
];

describe('sensitive-data settings tab', () => {
  it('exposes a dedicated administrator-only tab', () => {
    expect(environmentSettingsTabs).toContainEqual({ id: 'sensitive-data', label: '敏感数据过滤' });
    expect(isAdministratorOnlySettingsTab('sensitive-data')).toBe(true);
  });

  it('keeps every GLiNER filter setting out of runtime settings', () => {
    const definitionsByKey = new Map(runtimeEnvDefinitions.map((item) => [item.key, item]));
    for (const key of sensitiveDataSettingKeys) {
      expect(definitionsByKey.get(key)?.tab).toBe('sensitive-data');
    }
  });

  it('migrates the incompatible legacy GLiNER checkpoint', () => {
    const definition = runtimeEnvDefinitions.find((item) => item.key === 'GLINER_MODEL');
    expect(definition).toBeDefined();
    expect(normalizeRuntimeEnvValue(definition!, 'urchade/gliner_multi-v2.1'))
      .toBe('fastino/gliner2.5-multi-v1');
  });
});
