export function shouldIgnoreNetworkFailure(url: string, errorText?: string) {
  if (errorText === 'net::ERR_ABORTED' && /analytics|collector|apm|beacon|log|track/i.test(url)) return true;
  return /zhihu-web-analytics|datahub\.zhihu|apm\.zhihu|local\.adspower|118\.89\.204\.198/i.test(url);
}

export function snapshotFrameUrl(value?: string) {
  try {
    const url = new URL(value || '');
    url.hash = '';
    return url.href;
  } catch {
    return String(value || '').split('#', 1)[0];
  }
}

export function shouldIgnoreConsoleError(text: string) {
  return /zhihu-web-analytics|datahub\.zhihu|apm\.zhihu|local\.adspower|118\.89\.204\.198/i.test(text)
    || /collector|analytics|beacon|mixed content|cors policy|failed to load resource/i.test(text);
}

export function compactDiagnosticText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

export function unknownErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isAlreadyHandledJavaScriptDialogError(error: unknown) {
  return /(?:no dialog is showing|dialog which is already handled)/i.test(unknownErrorMessage(error));
}

export function stringifyDiagnosticValue(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
