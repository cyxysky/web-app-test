import { EmbeddedBrowserLibraryOverlay } from '@/components/EmbeddedBrowserLibraryOverlay';

export default function EmbeddedBrowserLibraryPage() {
  return (
    <>
      <style>{'html,body{background:transparent!important;overflow:hidden!important}'}</style>
      <EmbeddedBrowserLibraryOverlay />
    </>
  );
}
