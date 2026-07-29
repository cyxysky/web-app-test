import { WEBPILOT_BASE_PATH, withWebPilotBasePath } from '@/lib/webpilot-base-path';

export function browserReachableUrl(request: Request, port: number, basePath = WEBPILOT_BASE_PATH) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host') || '';
  const forwardedProto = request.headers.get('x-forwarded-proto') || '';
  const host = (forwardedHost || url.host || `127.0.0.1:${port}`).split(',')[0].trim();
  const protocol = forwardedProto === 'https' || url.protocol === 'https:' ? 'wss:' : 'ws:';
  const configuredPublicUrl = String(process.env.BROWSER_CHAT_PREVIEW_PUBLIC_URL || '').trim();
  if (configuredPublicUrl) {
    const configured = new URL(configuredPublicUrl);
    if (configured.protocol === 'http:') configured.protocol = 'ws:';
    if (configured.protocol === 'https:') configured.protocol = 'wss:';
    return configured.toString().replace(/\/$/, '');
  }
  const requestHostname = url.hostname.toLowerCase();
  const localRequest = requestHostname === 'localhost'
    || requestHostname === '127.0.0.1'
    || requestHostname === '0.0.0.0'
    || requestHostname === '[::1]'
    || requestHostname === '::1';
  const reverseProxyDetected = Boolean(forwardedHost || forwardedProto);
  if (basePath && reverseProxyDetected && !localRequest) {
    return `${protocol}//${host}${withWebPilotBasePath('/browser-preview', basePath)}`;
  }
  let hostname = url.hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    hostname = host;
  }
  if (localRequest || hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '[::1]' || hostname === '::1') hostname = '127.0.0.1';
  const reachableHostname = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${protocol}//${reachableHostname || '127.0.0.1'}:${port}/browser-preview`;
}
