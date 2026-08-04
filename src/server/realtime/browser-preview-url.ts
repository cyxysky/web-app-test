import { WEBPILOT_BASE_PATH, withWebPilotBasePath } from '@/lib/webpilot-base-path';

export function browserReachableUrl(request: Request, _port: number, basePath = WEBPILOT_BASE_PATH) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host') || '';
  const forwardedProto = request.headers.get('x-forwarded-proto') || '';
  const host = (forwardedHost || url.host).split(',')[0].trim();
  const protocol = forwardedProto === 'https' || url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${host}${withWebPilotBasePath('/browser-preview', basePath)}`;
}
