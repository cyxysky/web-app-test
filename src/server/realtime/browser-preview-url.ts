import { WEBPILOT_BASE_PATH, withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { requestPublicOrigin } from '@/server/auth/websocket-ticket';

export function browserReachableUrl(request: Request, _port: number, basePath = WEBPILOT_BASE_PATH) {
  const publicOrigin = new URL(requestPublicOrigin(request));
  publicOrigin.protocol = publicOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${publicOrigin.origin}${withWebPilotBasePath('/browser-preview', basePath)}`;
}
