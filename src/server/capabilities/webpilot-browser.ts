import {
  BrowserSession,
  type BrowserSessionOptions,
} from '@webpilot/capability-browser/node';
import { executeBrowserCodeRuntimeStateOperation } from '@/server/storage/browser-code-runtime-state';
import { artifactPath } from '@/server/storage/paths';

export function createWebPilotBrowserSession(options: BrowserSessionOptions = {}) {
  const configuredHost = options.host;
  return new BrowserSession({
    ...options,
    host: {
      artifactPath: configuredHost?.artifactPath || ((runId) => artifactPath(runId)),
      runtimeState: configuredHost?.runtimeState || executeBrowserCodeRuntimeStateOperation,
      waitForManualVerification: configuredHost?.waitForManualVerification,
    },
  });
}
