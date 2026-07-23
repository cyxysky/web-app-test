export const WEBPILOT_EMBED_SDK = String.raw`
(function () {
  'use strict';

  var VERSION = '0.3.0';
  var ELEMENT_NAME = 'webpilot-browser-chat';
  var currentScript = document.currentScript;

  function scriptBaseUrl(script) {
    if (!script || !script.src) return window.location.origin;
    var url = new URL(script.src, window.location.href);
    var suffix = '/embed/webpilot.js';
    if (url.pathname.endsWith(suffix)) {
      url.pathname = url.pathname.slice(0, -suffix.length) || '/';
    } else {
      url.pathname = url.pathname.replace(/\/[^/]*$/g, '') || '/';
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/g, '');
  }

  var defaultBaseUrl = scriptBaseUrl(currentScript);

  function joinUrl(base, path) {
    return String(base || '').replace(/\/+$/g, '') + '/' + String(path || '').replace(/^\/+/g, '');
  }

  function normalizeBaseUrl(value) {
    return new URL(String(value || defaultBaseUrl), window.location.href).toString().replace(/\/+$/g, '');
  }

  function parseJsonResponse(response) {
    return response.text().then(function (text) {
      var data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = { error: text };
        }
      }
      if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
      return data;
    });
  }

  function dispatch(element, name, detail) {
    element.dispatchEvent(new CustomEvent('webpilot:' + name, {
      bubbles: true,
      composed: true,
      detail: detail
    }));
  }

  function normalizeConfig(config) {
    var next = Object.assign({}, config || {});
    next.apiBaseUrl = normalizeBaseUrl(next.apiBaseUrl);
    if (!next.iframeUrl) {
      var frameUrl = new URL(joinUrl(next.apiBaseUrl, '/browser-chat'));
      frameUrl.searchParams.set('webpilotEmbed', '1');
      if (next.sessionId) frameUrl.searchParams.set('sessionId', next.sessionId);
      if (next.userId) frameUrl.searchParams.set('userId', next.userId);
      if (next.targetUrl) frameUrl.searchParams.set('targetUrl', next.targetUrl);
      next.iframeUrl = frameUrl.toString();
    }
    return next;
  }

  function frameTitle(config) {
    return config.title || 'WebPilot QA';
  }

  class WebPilotBrowserChatElement extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = normalizeConfig({});
    }

    connectedCallback() {
      this._render();
    }

    configure(config) {
      this._config = normalizeConfig(Object.assign({}, this._config, config || {}));
      if (this.isConnected) this._render();
      return this;
    }

    getFrame() {
      return this.shadowRoot ? this.shadowRoot.querySelector('iframe') : null;
    }

    reload() {
      var frame = this.getFrame();
      if (frame && frame.contentWindow) frame.contentWindow.location.reload();
    }

    destroy() {
      this.remove();
    }

    _render() {
      if (!this.shadowRoot) return;
      var title = frameTitle(this._config);
      this.shadowRoot.innerHTML = ''
        + '<style>'
        + ':host{display:block;width:100%;height:100%;min-height:600px;}'
        + 'iframe{display:block;width:100%;height:100%;min-height:inherit;border:0;background:#fff;}'
        + '</style>'
        + '<iframe'
        + ' title="' + title.replace(/"/g, '&quot;') + '"'
        + ' src="' + String(this._config.iframeUrl).replace(/"/g, '&quot;') + '"'
        + ' loading="eager"'
        + ' referrerpolicy="strict-origin-when-cross-origin"'
        + ' allow="clipboard-read; clipboard-write; fullscreen"'
        + '></iframe>';
      dispatch(this, 'frame-ready', { iframeUrl: this._config.iframeUrl, frame: this.getFrame() });
    }
  }

  function define() {
    if (!window.customElements) throw new Error('Custom Elements are not supported in this browser.');
    if (!window.customElements.get(ELEMENT_NAME)) {
      window.customElements.define(ELEMENT_NAME, WebPilotBrowserChatElement);
    }
    return window.customElements.get(ELEMENT_NAME);
  }

  function resolveTarget(target, config) {
    if (!target && config && config.mountId) target = '#' + config.mountId;
    if (typeof target === 'string') return document.querySelector(target);
    if (target && target.nodeType === 1) return target;
    return null;
  }

  function init(options) {
    options = Object.assign({ targetUrl: window.location.href }, options || {});
    var apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
    return fetch(joinUrl(apiBaseUrl, '/api/embed/browser-chat/init'), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(options)
    })
      .then(parseJsonResponse)
      .then(function (config) {
        config.apiBaseUrl = config.apiBaseUrl || apiBaseUrl;
        return config;
      });
  }

  function mount(target, config) {
    define();
    var options = config || {};
    if (target && target.nodeType !== 1 && typeof target === 'object' && !config) {
      options = target;
      target = null;
    }
    var container = resolveTarget(target, options);
    if (!container) return Promise.reject(new Error('WebPilot mount target was not found.'));
    var ready = options && options.iframeUrl
      ? Promise.resolve(options)
      : init(Object.assign({}, options, { mountId: options.mountId || container.id || undefined }));
    return ready.then(function (resolvedConfig) {
      var element = document.createElement(ELEMENT_NAME);
      element.configure(resolvedConfig);
      container.replaceChildren(element);
      dispatch(element, 'mounted', { config: resolvedConfig, frame: element.getFrame() });
      return element;
    });
  }

  function unmount(target) {
    var container = resolveTarget(target, {});
    if (!container) return false;
    var element = container.matches && container.matches(ELEMENT_NAME)
      ? container
      : container.querySelector(ELEMENT_NAME);
    if (!element) return false;
    element.destroy ? element.destroy() : element.remove();
    return true;
  }

  var WebPilotQA = Object.assign(window.WebPilotQA || {}, {
    version: VERSION,
    elementName: ELEMENT_NAME,
    apiBaseUrl: defaultBaseUrl,
    define: define,
    init: init,
    mount: mount,
    unmount: unmount
  });

  window.WebPilotQA = WebPilotQA;
  define();

  if (currentScript && currentScript.dataset && currentScript.dataset.mount) {
    mount(currentScript.dataset.mount, {
      apiBaseUrl: currentScript.dataset.apiBaseUrl || defaultBaseUrl,
      userId: currentScript.dataset.userId || currentScript.dataset.qzUserId || '',
      targetUrl: currentScript.dataset.targetUrl || window.location.href
    }).catch(function (error) {
      console.error('[WebPilotQA] auto mount failed:', error);
    });
  }
})();
`;
