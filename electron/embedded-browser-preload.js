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

function installEmbeddedBrowserClientHistoryBridge() {
  window.addEventListener('webpilot-embedded-browser-client-navigation', (event) => {
    ipcRenderer.send('webpilot:embedded-browser:client-navigation', event.detail || {});
  });

  const install = () => {
    try {
      const script = document.createElement('script');
      script.textContent = `
        (() => {
          if (window.__webPilotEmbeddedHistoryBridgeInstalled) return;
          Object.defineProperty(window, '__webPilotEmbeddedHistoryBridgeInstalled', {
            configurable: false,
            enumerable: false,
            value: true,
          });

          const stack = [window.location.href];
          let index = 0;
          let notifyTimer;

          const notify = (reason) => {
            clearTimeout(notifyTimer);
            notifyTimer = setTimeout(() => {
              window.dispatchEvent(new CustomEvent('webpilot-embedded-browser-client-navigation', {
                detail: {
                  canGoBack: index > 0 || window.history.length > 1,
                  canGoForward: index < stack.length - 1,
                  index,
                  length: stack.length,
                  reason,
                  url: window.location.href,
                },
              }));
            }, 20);
          };

          const remember = (reason, mode) => {
            const url = window.location.href;
            if (mode === 'replace') {
              stack[index] = url;
            } else if (stack[index] !== url) {
              stack.splice(index + 1);
              stack.push(url);
              index = stack.length - 1;
            }
            notify(reason);
          };

          const restoreIndex = (reason) => {
            const url = window.location.href;
            let nextIndex = -1;
            for (let i = stack.length - 1; i >= 0; i -= 1) {
              if (stack[i] === url) {
                nextIndex = i;
                break;
              }
            }
            if (nextIndex >= 0) {
              index = nextIndex;
            } else {
              stack.splice(index + 1);
              stack.push(url);
              index = stack.length - 1;
            }
            notify(reason);
          };

          try {
            const originalPushState = window.history.pushState;
            const originalReplaceState = window.history.replaceState;
            window.history.pushState = function webPilotPushState(...args) {
              const result = originalPushState.apply(this, args);
              remember('pushState', 'push');
              return result;
            };
            window.history.replaceState = function webPilotReplaceState(...args) {
              const result = originalReplaceState.apply(this, args);
              remember('replaceState', 'replace');
              return result;
            };
          } catch {}

          window.addEventListener('popstate', () => restoreIndex('popstate'));
          window.addEventListener('hashchange', () => restoreIndex('hashchange'));
          notify('init');
        })();
      `;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
    } catch {
      ipcRenderer.send('webpilot:embedded-browser:client-navigation', {
        canGoBack: window.history.length > 1,
        canGoForward: false,
        index: 0,
        length: window.history.length,
        reason: 'fallback-init',
        url: window.location.href,
      });
    }
  };

  if (document.documentElement) {
    install();
  } else {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  }
}

markEmbeddedBrowserView();
installEmbeddedBrowserFitStyle();
installEmbeddedBrowserClientHistoryBridge();
watchEmbeddedBrowserContentSize();
