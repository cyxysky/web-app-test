const serviceBrowserFileDeliveryError = [
  'Rejected service-browser file delivery.',
  'page.evaluate(), Blob/object URLs, window.open(), and HTML download clicks run in the backend Playwright browser and do not deliver a file to the user browser.',
  'Use file action=generate to create new content or file action=download with a real HTTP(S) URL to register a current-session Artifact.',
  'Only the Artifact download URL returned by one of those tools is user-visible delivery evidence.',
].join(' ');

export function browserCodeServiceFileDeliveryViolation(code: string) {
  const source = String(code || '');
  const evaluatesInPage = /\bpage\s*\.\s*evaluate\s*\(/.test(source);
  if (!evaluatesInPage) return undefined;
  const createsBrowserOnlyFile = /\bnew\s+Blob\s*\(|\bURL\s*\.\s*createObjectURL\s*\(|\bdata:[^\s'"`]+/.test(source);
  const triggersBrowserOnlyDelivery = /\bwindow\s*\.\s*open\s*\(|\.\s*download\s*=|setAttribute\s*\(\s*['"]download['"]|showSaveFilePicker\s*\(/.test(source);
  return createsBrowserOnlyFile && triggersBrowserOnlyDelivery ? serviceBrowserFileDeliveryError : undefined;
}
