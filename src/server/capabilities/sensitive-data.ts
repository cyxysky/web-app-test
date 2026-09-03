import { capabilityConfigurationFromEnvironment } from '@webpilot/capability-host';
import { sensitiveDataCapabilityManifest } from '@webpilot/capability-sensitive-data';
import {
  createNodeSensitiveDataFilter,
  sensitiveDataFilterConfigFromEnvironment,
} from '@webpilot/capability-sensitive-data/node';

const sensitiveDataRuntime = createNodeSensitiveDataFilter({
  getConfig: () => sensitiveDataFilterConfigFromEnvironment(
    capabilityConfigurationFromEnvironment(sensitiveDataCapabilityManifest, process.env),
  ),
});

export const filterSensitiveData = sensitiveDataRuntime.filterSensitiveData;
export const redactSensitiveTexts = sensitiveDataRuntime.redactSensitiveTexts;
