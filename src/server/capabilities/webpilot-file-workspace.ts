import { createNodeFileWorkspace } from '@webpilot/capability-file/node/workspace';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { artifactsRoot } from '@/server/storage/paths';

export function createWebPilotFileWorkspace() {
  return createNodeFileWorkspace({
    artifactsRoot: artifactsRoot(),
    artifactUrl: ({ relativePath }) => artifactApiUrlFromRelative(relativePath),
  });
}
