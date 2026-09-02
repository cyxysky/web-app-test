export type BrowserSessionTransportKind =
  | 'shared'
  | 'electron-cdp'
  | 'cdp'
  | 'persistent-cdp'
  | 'persistent'
  | 'launched';

export type BrowserSessionTransportAdapter = {
  kind: BrowserSessionTransportKind;
  ownership: 'shared' | 'connected' | 'persistent' | 'launched';
};

export function resolveBrowserSessionTransportAdapter(input: {
  autoTabGroupCdpEndpoint?: string;
  cdpEndpoint?: string;
  electronEmbedded: boolean;
  shared: boolean;
  userDataDir?: string;
}): BrowserSessionTransportAdapter {
  if (input.shared) return { kind: 'shared', ownership: 'shared' };
  if (input.cdpEndpoint) {
    return input.electronEmbedded
      ? { kind: 'electron-cdp', ownership: 'connected' }
      : { kind: 'cdp', ownership: 'connected' };
  }
  if (input.userDataDir) {
    return input.autoTabGroupCdpEndpoint
      ? { kind: 'persistent-cdp', ownership: 'connected' }
      : { kind: 'persistent', ownership: 'persistent' };
  }
  return { kind: 'launched', ownership: 'launched' };
}
