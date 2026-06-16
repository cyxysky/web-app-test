const { ipcRenderer } = require('electron');

function markEmbeddedBrowserView() {
  try {
    Object.defineProperty(window, '__webPilotEmbeddedBrowserView', {
      configurable: true,
      enumerable: false,
      value: true,
    });
  } catch {
    window.__webPilotEmbeddedBrowserView = true;
  }

  const applyDocumentMarker = () => {
    try {
      document.documentElement?.setAttribute('data-webpilot-embedded-browser', 'true');
    } catch {
      // This marker is only a hint for Playwright page selection.
    }
  };

  applyDocumentMarker();
  window.addEventListener('DOMContentLoaded', applyDocumentMarker, { once: true });
}

function watchEmbeddedBrowserContentSize() {
  let timer;
  let resizeObserver;
  let lastWidth = 0;
  let lastHeight = 0;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const doc = document.documentElement;
      const body = document.body;
      const width = Math.max(
        doc ? doc.scrollWidth : 0,
        body ? body.scrollWidth : 0,
        window.innerWidth || 0,
      );
      const height = Math.max(
        doc ? doc.scrollHeight : 0,
        body ? body.scrollHeight : 0,
        window.innerHeight || 0,
      );
      if (Math.abs(width - lastWidth) < 8 && Math.abs(height - lastHeight) < 24) return;
      lastWidth = width;
      lastHeight = height;
      ipcRenderer.send('webpilot:embedded-browser:content-resized');
    }, 320);
  };
  const observe = () => {
    notify();
    try {
      resizeObserver = new ResizeObserver(notify);
      if (document.documentElement) resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
      window.__webPilotEmbeddedBrowserResizeObserver = resizeObserver;
    } catch {
      window.addEventListener('resize', notify);
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', observe, { once: true });
  } else {
    observe();
  }
}

function installEmbeddedBrowserFitStyle() {
  const apply = () => {
    try {
      if (document.getElementById('webpilot-embedded-browser-fit-style')) return;
      const style = document.createElement('style');
      style.id = 'webpilot-embedded-browser-fit-style';
      style.textContent = 'html,body{overflow-x:hidden!important;}';
      (document.head || document.documentElement).appendChild(style);
    } catch {
      // The zoom fit in the main process is still the primary behavior.
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
}

markEmbeddedBrowserView();
installEmbeddedBrowserFitStyle();
watchEmbeddedBrowserContentSize();
