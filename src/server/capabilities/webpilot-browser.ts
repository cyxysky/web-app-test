import {
  BrowserSession,
  type BrowserSessionOptions,
} from '@webpilot/capability-browser/node';
import { executeBrowserCodeRuntimeStateOperation } from '@/server/storage/browser-code-runtime-state';
import { artifactPath } from '@/server/storage/paths';
import { artifactsRoot } from '@/server/storage/paths';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { createNodeFileDownloadReceiver } from '@webpilot/capability-file/node';

export function createWebPilotBrowserSession(options: BrowserSessionOptions = {}) {
  const configuredHost = options.host;
  return new BrowserSession({
    ...options,
    host: {
      ...configuredHost,
      receiveDownload: configuredHost?.receiveDownload || createNodeFileDownloadReceiver({
        artifactsRoot: artifactsRoot(), artifactUrl: ({ relativePath }) => artifactApiUrlFromRelative(relativePath),
      }),
      artifactPath: configuredHost?.artifactPath || ((runId) => artifactPath(runId)),
      runtimeState: configuredHost?.runtimeState || executeBrowserCodeRuntimeStateOperation,
      waitForManualVerification: configuredHost?.waitForManualVerification,
    },
  });
}
