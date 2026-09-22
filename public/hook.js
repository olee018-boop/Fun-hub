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
  var WS_PREFIX = '/ws/';
  var NativeURL = window.URL;
  var cfg = window.__PX__ || {};
  var base = cfg.base || location.href;
  var OPAQUE = /^(data:|blob:|javascript:|mailto:|tel:|about:|#|sms:|magnet:|intent:)/i;

  /* ---------------------------------------------------------------- utils */

  // The real URL of the page we are pretending to be.
  function realHref() {
    return unproxy(location.href) || base;
  }

  function decodeTarget(raw) {
    return raw.replace(/^(https?:)\/{0,2}/i, function (_m, scheme) {
      return scheme.toLowerCase() + '//';
    });
  }

  function onOurOrigin(parsed) {
    return parsed.host === location.host && /^(https?|wss?):$/.test(parsed.protocol);
  }

  /**
   * The real absolute URL a value refers to, or null if it isn't ours to touch.
   *
   * The subtle case: a page that builds `location.host + '/api'` or reads
   * `location.origin` produces a URL pointing at the *proxy*. Those are meant
   * for the site the page thinks it is on, so send them there.
   */
  function resolveReal(u) {
    var parsed;
    try {
      parsed = new NativeURL(String(u), location.href);
    } catch (e) {
      return null;
    }

    if (!onOurOrigin(parsed)) return parsed.href;
    if (parsed.pathname.indexOf('/__px/') === 0) return null; // the shell's own endpoints
    if (parsed.pathname.indexOf(PREFIX) === 0) {
      return decodeTarget(parsed.pathname.slice(PREFIX.length) + parsed.search + parsed.hash);
    }
    try {
      return new NativeURL(parsed.pathname + parsed.search + parsed.hash, realHref()).href;
    } catch (e) {
      return null;
    }
  }

  function unproxy(u) {
    try {
      var parsed = new NativeURL(u, location.href);
      if (parsed.origin !== location.origin) return String(u);
      if (parsed.pathname.indexOf(PREFIX) !== 0) return null;
      return decodeTarget(parsed.pathname.slice(PREFIX.length) + parsed.search + parsed.hash);
    } catch (e) {
      return null;
    }
  }

  function proxy(u) {
    if (u == null) return u;
    var s = String(u);
    if (!s || OPAQUE.test(s)) return s;
    var real = resolveReal(s);
    if (!real) return s;
    if (!/^https?:\/\//i.test(real)) return s; // ws:, ftp: and friends go elsewhere
    return PREFIX + real;
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

  /* --------------------------------------------------------- URL resolution */

  // Page code constantly does new URL('/api', location.href). Left alone that
  // resolves against the proxy's own origin and loses the site entirely, so
  // resolve against the real URL instead and hand back the real result — the
  // patched fetch/XHR below put it back through the proxy when it is used.
  function PxURL(url, base) {
    var resolvedBase = base;
    if (base !== undefined && base !== null) {
      resolvedBase = unproxy(String(base)) || String(base);
    } else if (typeof url === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      resolvedBase = realHref(); // relative with no base: the document's real URL
    }
    var input = typeof url === 'string' ? unproxy(url) || url : url;
    return resolvedBase === undefined || resolvedBase === null
      ? new NativeURL(input)
      : new NativeURL(input, resolvedBase);
  }
  // Sharing the prototype keeps `x instanceof URL` true for natively built
  // URLs as well as ours; the prototype chain carries the statics.
  PxURL.prototype = NativeURL.prototype;
  Object.setPrototypeOf(PxURL, NativeURL);
  try {
    window.URL = PxURL;
  } catch (e) {
    /* locked down: keep the native one */
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

  // WebSockets cannot reach the target directly from this origin, so route
  // them through the server's relay at /ws/<absolute url>.
  if (window.WebSocket) {
    var NativeWS = window.WebSocket;
    var PxWebSocket = function (url, protocols) {
      var relayed = url;
      var real = resolveReal(url);
      if (real) {
        var wsUrl = real.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        if (/^wss?:\/\//i.test(wsUrl)) {
          relayed =
            (location.protocol === 'https:' ? 'wss://' : 'ws://') +
            location.host + WS_PREFIX + wsUrl;
        }
      }
      return protocols === undefined ? new NativeWS(relayed) : new NativeWS(relayed, protocols);
    };
    PxWebSocket.prototype = NativeWS.prototype;
    Object.setPrototypeOf(PxWebSocket, NativeWS);
    try {
      window.WebSocket = PxWebSocket;
    } catch (e) {
      /* keep the native one */
    }
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

  /* --------------------------------------------------------------- cookies */

  // Every proxied site shares this one browser origin, so raw document.cookie
  // would let sites read and clobber each other's cookies. Namespace them per
  // site, and mirror writes to the server jar so they ride along on requests.
  (function patchCookies() {
    var descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (!descriptor || !descriptor.get || !descriptor.set || !descriptor.configurable) return;

    var siteOrigin;
    try {
      siteOrigin = new NativeURL(realHref()).origin;
    } catch (e) {
      return;
    }

    // Short stable tag per origin, so one site's cookies can't be read by another.
    var hash = 5381;
    for (var i = 0; i < siteOrigin.length; i++) hash = ((hash * 33) ^ siteOrigin.charCodeAt(i)) >>> 0;
    var tag = '__px' + hash.toString(36) + '_';

    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () {
        var raw = descriptor.get.call(document) || '';
        return raw
          .split(';')
          .map(function (part) { return part.trim(); })
          .filter(function (part) { return part.indexOf(tag) === 0; })
          .map(function (part) { return part.slice(tag.length); })
          .join('; ');
      },
      set: function (value) {
        var text = String(value);
        var eq = text.indexOf('=');
        var semi = text.indexOf(';');
        if (eq === -1 || (semi !== -1 && semi < eq)) return;

        var attrs = semi === -1 ? '' : text.slice(semi);
        var name = text.slice(0, eq).trim();
        var rest = semi === -1 ? text.slice(eq + 1) : text.slice(eq + 1, semi);

        // Domain and Path refer to the real site, not to us: drop Domain and
        // pin Path to / so the cookie behaves the same across that site.
        var kept = attrs
          .split(';')
          .filter(function (a) {
            var key = a.split('=')[0].trim().toLowerCase();
            return key && key !== 'domain' && key !== 'path' && key !== 'secure';
          })
          .join(';');

        descriptor.set.call(document, tag + name + '=' + rest + ';Path=/' + (kept ? ';' + kept : ''));

        // Deliberately the native fetch: the patched one would resolve this
        // against the target site and post the cookie to them instead of us.
        try {
          if (!nativeFetch) return;
          nativeFetch.call(window, '/__px/cookie', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: realHref(), cookie: name + '=' + rest + attrs }),
            keepalive: true,
          }).catch(function () {});
        } catch (e) {
          /* best effort */
        }
      },
    });

    // Seed whatever the server already holds for this site.
    var seeds = cfg.cookies || [];
    for (var j = 0; j < seeds.length; j++) {
      try {
        descriptor.set.call(document, tag + seeds[j].name + '=' + seeds[j].value + ';Path=/');
      } catch (e) {
        /* skip a bad one */
      }
    }
  })();

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
    if (node.hasAttribute && node.hasAttribute('data-px-hook')) return;
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
      var dest = new NativeURL(actionReal, realHref());
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
