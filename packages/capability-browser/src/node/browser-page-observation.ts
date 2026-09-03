export type BrowserActiveSurface = {
  id: string;
  descriptor: string;
  kind: 'dialog' | 'popover' | 'menu' | 'listbox' | 'panel' | 'overlay';
  label: string;
  modal: boolean;
  likelyOverlay: boolean;
  focusedInside: boolean;
  zIndex: number;
  rect: {
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
  };
  signals: string[];
  selector?: string;
  framePath?: string;
  parentId?: string;
  depth: number;
  activationOrder: number;
};

export type BrowserPageObservation = {
  epoch: number;
  url: string;
  title: string;
  focusedElement?: {
    descriptor: string;
    label: string;
  };
  activeSurface?: BrowserActiveSurface;
  surfaces: BrowserActiveSurface[];
  surfaceStack: BrowserActiveSurface[];
  topSurfaceIds: string[];
  surfaceTransition: 'initial' | 'unchanged' | 'opened' | 'closed' | 'changed';
};
