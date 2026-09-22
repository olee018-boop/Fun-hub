/* Injected into every proxied page, ahead of the page's own scripts.
 *
 * The server rewrites the markup it can see. This handles everything it can't:
 * fetch/XHR, DOM built at runtime, history changes, popups and form posts.
 */
(function () {
  'use strict';
  if (window.__PX_HOOK_INSTALLED__) return;
  window.__PX_HOOK_INSTALLED__ = true;

  var PREFIX = '/p/';
  var cfg = window.__PX__ || {};
  var base = cfg.base || location.href;
  var OPAQUE = /^(data:|blob:|javascript:|mailto:|tel:|about:|#|sms:|magnet:|intent:)/i;

  /* ---------------------------------------------------------------- utils */

  // The real URL of the page we are pretending to be.
  function realHref() {
    return unproxy(location.href) || base;
  }

  function unproxy(u) {
    try {
      var parsed = new URL(u, location.href);
      if (parsed.origin !== location.origin) return String(u);
      if (parsed.pathname.indexOf(PREFIX) !== 0) return null;
      var raw = parsed.pathname.slice(PREFIX.length) + parsed.search + parsed.hash;
      return raw.replace(/^(https?:)\/{0,2}/i, function (_m, s) {
        return s.toLowerCase() + '//';
      });
    } catch (e) {
      return null;
    }
  }

  function proxy(u) {
    if (u == null) return u;
    var s = String(u);
    if (!s || OPAQUE.test(s)) return s;
    try {
      var abs = new URL(s, realHref());
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return s;
      return PREFIX + abs.href;
    } catch (e) {
      return s;
    }
  }
  window.__pxProxy = proxy;
  window.__pxUnproxy = unproxy;

  function tellParent(type, payload) {
    if (window.parent === window) return;
    try {
      payload = payload || {};
      payload.type = type;
      payload.pxFrame = true;
      window.parent.postMessage(payload, '*');
    } catch (e) {
      /* parent went away */
    }
  }

  /* ------------------------------------------------------- network layer */

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          input = proxy(String(input));
        } else if (input && input.url) {
          input = new Request(proxy(input.url), input);
        }
      } catch (e) {
        /* fall through with the original input */
      }
      return nativeFetch.call(this, input, init);
    };
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = proxy(url);
    return xhrOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return beacon(proxy(url), data);
    };
  }

  if (window.EventSource) {
    var NativeES = window.EventSource;
    window.EventSource = function (url, config) {
      return new NativeES(proxy(url), config);
    };
    window.EventSource.prototype = NativeES.prototype;
  }

  if (window.Worker) {
    var NativeWorker = window.Worker;
    window.Worker = function (url, options) {
      return new NativeWorker(proxy(url), options);
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  // Service workers would install against our origin and intercept every proxy
  // request. Hand back a promise that never resolves rather than let that happen.
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    navigator.serviceWorker.register = function () {
      return new Promise(function () {});
    };
  }

  /* ----------------------------------------------------------- DOM layer */

  var URL_ATTRS = { href: 1, src: 1, action: 1, formaction: 1, poster: 1, data: 1, cite: 1 };

  var setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var lower = String(name).toLowerCase();
    if (URL_ATTRS[lower]) {
      return setAttribute.call(this, name, proxy(value));
    }
    if (lower === 'srcset' || lower === 'imagesrcset') {
      return setAttribute.call(this, name, proxySrcset(value));
    }
    return setAttribute.call(this, name, value);
  };

  function proxySrcset(value) {
    return String(value)
      .split(',')
      .map(function (part) {
        var t = part.trim();
        if (!t) return null;
        var bits = t.split(/\s+/);
        bits[0] = proxy(bits[0]);
        return bits.join(' ');
      })
      .filter(Boolean)
      .join(', ');
  }

  // Patch the reflected IDL properties (el.src = ...) so scripts that never
  // touch setAttribute are covered too. The getter returns the *real* URL,
  // because page code frequently parses it.
  function patchProp(ctor, prop) {
    if (!ctor || !ctor.prototype) return;
    var desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!desc || !desc.get || !desc.set || !desc.configurable) return;
    Object.defineProperty(ctor.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        var raw = desc.get.call(this);
        return unproxy(raw) || raw;
      },
      set: function (value) {
        desc.set.call(this, proxy(value));
      },
    });
  }

  [
    [window.HTMLAnchorElement, 'href'],
    [window.HTMLAreaElement, 'href'],
    [window.HTMLLinkElement, 'href'],
    [window.HTMLImageElement, 'src'],
    [window.HTMLScriptElement, 'src'],
    [window.HTMLIFrameElement, 'src'],
    [window.HTMLFrameElement, 'src'],
    [window.HTMLEmbedElement, 'src'],
    [window.HTMLMediaElement, 'src'],
    [window.HTMLSourceElement, 'src'],
    [window.HTMLTrackElement, 'src'],
    [window.HTMLObjectElement, 'data'],
    [window.HTMLFormElement, 'action'],
    [window.HTMLVideoElement, 'poster'],
  ].forEach(function (pair) {
    patchProp(pair[0], pair[1]);
  });

  // innerHTML, document.write, template cloning and framework renderers all
  // land here eventually.
  function fixNode(node) {
    if (!node || node.nodeType !== 1) return;
    for (var attr in URL_ATTRS) {
      if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
      var value = node.getAttribute(attr);
      if (value && !OPAQUE.test(value) && String(value).indexOf(PREFIX) !== 0) {
        var abs = proxy(value);
        if (abs !== value) setAttribute.call(node, attr, abs);
      }
    }
    if (node.hasAttribute && node.hasAttribute('srcset')) {
      var ss = node.getAttribute('srcset');
      if (ss && ss.indexOf(PREFIX) === -1) setAttribute.call(node, 'srcset', proxySrcset(ss));
    }
  }

  function fixTree(root) {
    fixNode(root);
    if (root.querySelectorAll) {
      var found = root.querySelectorAll('[href],[src],[action],[formaction],[poster],[data],[srcset]');
      for (var i = 0; i < found.length; i++) fixNode(found[i]);
    }
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === 'attributes') {
        fixNode(record.target);
      } else {
        for (var j = 0; j < record.addedNodes.length; j++) fixTree(record.addedNodes[j]);
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'src', 'action', 'formaction', 'poster', 'data', 'srcset'],
  });

  /* ------------------------------------------------------ navigation UX */

  // history.pushState('/some/path') must stay inside /p/, or the next reload
  // leaves the proxy entirely.
  ['pushState', 'replaceState'].forEach(function (name) {
    var native = history[name];
    history[name] = function (state, title, url) {
      var rewritten = url == null ? url : proxy(url);
      var result = native.call(this, state, title, rewritten);
      reportLocation();
      return result;
    };
  });
  window.addEventListener('popstate', reportLocation);
  window.addEventListener('hashchange', reportLocation);

  var nativeOpen = window.open;
  window.open = function (url, name, features) {
    var target = url ? proxy(url) : url;
    // Let the browser UI own popups so they become real tabs.
    if (window.parent !== window) {
      tellParent('px:newtab', { url: unproxy(target) || String(url || '') });
      return null;
    }
    return nativeOpen.call(window, target, name, features);
  };

  document.addEventListener(
    'click',
    function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      var anchor = event.target && event.target.closest && event.target.closest('a[href]');
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (!href || OPAQUE.test(href)) return;
      var wantsNewTab = anchor.target === '_blank' || event.ctrlKey || event.metaKey;
      if (!wantsNewTab) return;
      event.preventDefault();
      tellParent('px:newtab', { url: unproxy(anchor.href) || anchor.href });
    },
    true
  );

  // A GET form appends its own query string, which would collide with the query
  // already baked into the proxied action. Build the final URL ourselves.
  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!form || form.tagName !== 'FORM') return;
      var method = String(form.getAttribute('method') || 'get').toLowerCase();
      if (method !== 'get') return;
      var actionAttr = form.getAttribute('action');
      var actionReal = actionAttr ? unproxy(proxy(actionAttr)) : realHref();
      if (!actionReal) return;
      event.preventDefault();
      var dest = new URL(actionReal, realHref());
      dest.search = new URLSearchParams(new FormData(form)).toString();
      dest.hash = '';
      location.href = proxy(dest.href);
    },
    true
  );

  /* -------------------------------------------------- report to the shell */

  var lastReported = null;
  function reportLocation() {
    var url = realHref();
    var title = document.title || '';
    var key = url + '\n' + title;
    if (key === lastReported) return;
    lastReported = key;
    tellParent('px:location', { url: url, title: title });
  }

  reportLocation();
  document.addEventListener('DOMContentLoaded', reportLocation);
  window.addEventListener('load', function () {
    reportLocation();
    var titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(reportLocation).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  });
  window.addEventListener('beforeunload', function () {
    tellParent('px:loading', {});
  });
  document.addEventListener('keydown', function (event) {
    // Let the shell handle its own shortcuts even while the page has focus.
    if ((event.ctrlKey || event.metaKey) && ['t', 'w', 'l', 'r'].indexOf(event.key.toLowerCase()) !== -1) {
      tellParent('px:shortcut', { key: event.key.toLowerCase(), shift: event.shiftKey });
      if (event.key.toLowerCase() !== 'r') event.preventDefault();
    }
  });
})();
