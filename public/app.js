/* The browser shell: tabs, history, omnibox and bookmarks.
 *
 * Every tab owns one same-origin iframe pointed at /p/<url>. Because the frame
 * is same-origin we can read its location and drive it directly; the injected
 * hook inside it also posts title/URL updates back to us.
 */
(function () {
  'use strict';

  var PREFIX = '/p/';
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    tabs: $('tabs'), newtab: $('newtab'), viewport: $('viewport'),
    back: $('back'), forward: $('forward'), reload: $('reload'), home: $('home'),
    address: $('address'), scheme: $('scheme'), bookmark: $('bookmark'),
    progress: $('progress'), bookmarks: $('bookmarks'),
    newtabPage: $('newtab-page'), newtabForm: $('newtab-form'), newtabInput: $('newtab-input'),
    loading: $('loading'), loadingHost: $('loading-host'),
    shortcuts: $('shortcuts'), settings: $('settings'), settingsBtn: $('settings-btn'),
    settingsClose: $('settings-close'), engine: $('engine'), restore: $('restore'),
    clearData: $('clear-data'),
  };

  /* ------------------------------------------------------------- settings */

  var prefs = load('px.prefs', { engine: 'duckduckgo', restore: true });
  var bookmarks = load('px.bookmarks', [
    { title: 'Wikipedia', url: 'https://en.wikipedia.org' },
    { title: 'Hacker News', url: 'https://news.ycombinator.com' },
    { title: 'DuckDuckGo', url: 'https://duckduckgo.com' },
  ]);

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  /* ------------------------------------------------------------ URL utils */

  function toProxy(url) { return PREFIX + url; }

  function fromProxy(href) {
    if (!href) return '';
    try {
      var parsed = new URL(href, location.origin);
      if (parsed.pathname.indexOf(PREFIX) !== 0) return '';
      var raw = parsed.pathname.slice(PREFIX.length) + parsed.search + parsed.hash;
      return raw.replace(/^(https?:)\/{0,2}/i, function (_m, s) { return s.toLowerCase() + '//'; });
    } catch (e) {
      return '';
    }
  }

  // Mirrors resolveQuery() on the server so the UI and /__px/go agree.
  var LOOKS_LIKE_HOST = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i;
  var ENGINES = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    'duckduckgo-lite': 'https://lite.duckduckgo.com/lite/?q=',
    bing: 'https://www.bing.com/search?q=',
    google: 'https://www.google.com/search?q=',
    wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
  };

  function resolveQuery(input) {
    var q = String(input || '').trim();
    if (!q) return '';
    if (/^https?:\/\//i.test(q)) return q;
    if (!/\s/.test(q) && LOOKS_LIKE_HOST.test(q)) return 'https://' + q.replace(/^\/+/, '');
    return (ENGINES[prefs.engine] || ENGINES.duckduckgo) + encodeURIComponent(q);
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  function faviconFor(url) {
    var host = hostOf(url);
    return host ? toProxy('https://icons.duckduckgo.com/ip3/' + host + '.ico') : '';
  }

  /* ----------------------------------------------------------- tab model */

  var tabs = [];
  var activeId = null;
  var nextId = 1;

  function activeTab() {
    return tabs.find(function (t) { return t.id === activeId; }) || null;
  }

  function createTab(url, options) {
    options = options || {};
    var tab = {
      id: nextId++,
      title: 'New tab',
      url: '',
      history: [],
      index: -1,
      loading: false,
      frame: null,
    };
    tabs.push(tab);
    if (!options.background || activeId === null) activeId = tab.id;
    renderTabs();
    if (url) navigate(url, { tabId: tab.id });
    else { syncChrome(); persist(); }
    return tab;
  }

  function closeTab(id) {
    var i = tabs.findIndex(function (t) { return t.id === id; });
    if (i === -1) return;
    var tab = tabs[i];
    clearTimeout(tab.loadTimer);
    if (tab.frame) tab.frame.remove();
    tabs.splice(i, 1);

    if (activeId === id) {
      var next = tabs[i] || tabs[i - 1];
      activeId = next ? next.id : null;
    }
    if (!tabs.length) createTab('');
    renderTabs();
    syncChrome();
    persist();
  }

  function selectTab(id) {
    if (activeId === id) return;
    activeId = id;
    els.address.blur();
    renderTabs();
    syncChrome();
    persist();
  }

  /* ------------------------------------------------------------- frames */

  function frameFor(tab) {
    if (tab.frame) return tab.frame;
    var frame = document.createElement('iframe');
    // No allow-top-navigation: a proxied page must never replace the shell.
    frame.setAttribute(
      'sandbox',
      'allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-presentation'
    );
    frame.setAttribute(
      'allow',
      'fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; accelerometer; gyroscope'
    );
    frame.dataset.tabId = String(tab.id);
    frame.hidden = tab.id !== activeId;
    frame.addEventListener('load', function () { onFrameLoad(tab); });
    els.viewport.appendChild(frame);
    tab.frame = frame;
    return frame;
  }

  function onFrameLoad(tab) {
    var real = currentFrameUrl(tab);
    // A freshly appended iframe fires load for about:blank before the real
    // navigation even starts. Acting on that would clear the loading state
    // immediately and the spinner would never be seen.
    if (!real && tab.url) return;

    setLoading(tab, false);
    if (real && real !== tab.url) recordVisit(tab, real);
    // The hook reports the real title; this is the fallback for pages where it
    // could not run (plain images, downloads, error pages).
    if (!tab.title || tab.title === 'New tab' || tab.title === 'Loading…') {
      var docTitle = '';
      try { docTitle = tab.frame.contentDocument.title; } catch (e) { /* opaque */ }
      tab.title = docTitle || hostOf(tab.url) || 'Untitled';
    }
    renderTabs();
    syncChrome();
    persist();
  }

  function currentFrameUrl(tab) {
    if (!tab.frame) return '';
    try {
      return fromProxy(tab.frame.contentWindow.location.href);
    } catch (e) {
      return fromProxy(tab.frame.getAttribute('src') || '');
    }
  }

  var LOAD_TIMEOUT_MS = 30000;

  /** Flip a tab's loading state, guarding against a load event that never comes. */
  function setLoading(tab, value) {
    tab.loading = value;
    clearTimeout(tab.loadTimer);
    if (value) {
      tab.loadTimer = setTimeout(function () {
        tab.loading = false;
        renderTabs();
        if (tab.id === activeId) syncChrome();
      }, LOAD_TIMEOUT_MS);
    }
  }

  /* --------------------------------------------------------- navigation */

  function navigate(input, options) {
    options = options || {};
    var tab = options.tabId ? tabs.find(function (t) { return t.id === options.tabId; }) : activeTab();
    if (!tab) tab = createTab('');

    var url = options.raw ? input : resolveQuery(input);
    if (!url) return;

    pushHistory(tab, url);
    loadIntoFrame(tab, url);
  }

  function pushHistory(tab, url) {
    if (tab.history[tab.index] === url) return;
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
  }

  function loadIntoFrame(tab, url) {
    tab.url = url;
    tab.title = 'Loading…';
    setLoading(tab, true);
    var frame = frameFor(tab);
    var proxied = toProxy(url);

    // location.replace keeps the shell's own session history clean, so the
    // browser's Back button never walks through the frames' entries.
    var replaced = false;
    try {
      if (frame.contentWindow && frame.getAttribute('src')) {
        frame.contentWindow.location.replace(proxied);
        replaced = true;
      }
    } catch (e) { /* frame went cross-origin; fall back to src */ }
    if (!replaced) frame.setAttribute('src', proxied);

    renderTabs();
    syncChrome();
    persist();
  }

  /** A navigation that happened inside the frame, reported by the hook. */
  function recordVisit(tab, url) {
    if (!url || url === tab.url) return;
    tab.url = url;
    pushHistory(tab, url);
    renderTabs();
    if (tab.id === activeId) syncChrome();
    persist();
  }

  function goBack() {
    var tab = activeTab();
    if (!tab || tab.index <= 0) return;
    tab.index--;
    loadIntoFrame(tab, tab.history[tab.index]);
  }

  function goForward() {
    var tab = activeTab();
    if (!tab || tab.index >= tab.history.length - 1) return;
    tab.index++;
    loadIntoFrame(tab, tab.history[tab.index]);
  }

  function reload() {
    var tab = activeTab();
    if (!tab || !tab.url) return;
    setLoading(tab, true);
    renderTabs();
    try {
      tab.frame.contentWindow.location.reload();
    } catch (e) {
      loadIntoFrame(tab, tab.url);
    }
  }

  /* ------------------------------------------------------------ rendering */

  function renderTabs() {
    els.tabs.textContent = '';
    tabs.forEach(function (tab) {
      var el = document.createElement('div');
      el.className = 'tab' + (tab.id === activeId ? ' active' : '') + (tab.loading ? ' loading' : '');
      el.title = tab.url || 'New tab';

      var icon = document.createElement('img');
      icon.className = 'tab-favicon';
      var src = tab.url ? faviconFor(tab.url) : '';
      if (src) {
        icon.src = src;
        icon.addEventListener('error', function () { icon.classList.add('placeholder'); icon.removeAttribute('src'); });
      } else {
        icon.classList.add('placeholder');
      }

      var title = document.createElement('div');
      title.className = 'tab-title';
      title.textContent = tab.title || 'New tab';

      var close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close tab (Ctrl+W)';
      close.addEventListener('click', function (event) {
        event.stopPropagation();
        closeTab(tab.id);
      });

      el.append(icon, title, close);
      el.addEventListener('mousedown', function (event) {
        if (event.button === 1) { event.preventDefault(); closeTab(tab.id); }
        else if (event.button === 0) selectTab(tab.id);
      });
      els.tabs.appendChild(el);
    });

    tabs.forEach(function (tab) {
      if (tab.frame) tab.frame.hidden = tab.id !== activeId;
    });
  }

  /** Point the toolbar, omnibox and new-tab panel at the active tab. */
  var addressTabId = null;
  function syncChrome() {
    var tab = activeTab();
    var url = tab ? tab.url : '';
    var tabId = tab ? tab.id : null;

    // Half-typed text in the omnibox is the user's, so a background update
    // leaves it alone — but switching tabs always shows the new tab's URL.
    if (document.activeElement !== els.address || addressTabId !== tabId) {
      els.address.value = url;
    }
    addressTabId = tabId;

    els.scheme.textContent = url ? (url.indexOf('https://') === 0 ? '🔒' : '⚠') : '';
    els.scheme.className = 'scheme ' + (url ? (url.indexOf('https://') === 0 ? 'secure' : 'insecure') : '');

    els.back.disabled = !tab || tab.index <= 0;
    els.forward.disabled = !tab || tab.index >= tab.history.length - 1;
    els.reload.disabled = !url;
    els.bookmark.textContent = isBookmarked(url) ? '★' : '☆';
    els.bookmark.classList.toggle('saved', isBookmarked(url));
    els.bookmark.disabled = !url;

    var busy = !!(tab && tab.loading && tab.url);
    els.progress.classList.toggle('active', busy);
    els.loading.classList.toggle('visible', busy);
    if (busy) els.loadingHost.textContent = hostOf(tab.url) || tab.url;
    els.newtabPage.classList.toggle('visible', !url);
    document.title = tab && tab.title && url ? tab.title + ' — Fun-hub' : 'Fun-hub Browser';
  }

  /* ----------------------------------------------------------- bookmarks */

  function isBookmarked(url) {
    return !!url && bookmarks.some(function (b) { return b.url === url; });
  }

  function toggleBookmark() {
    var tab = activeTab();
    if (!tab || !tab.url) return;
    if (isBookmarked(tab.url)) {
      bookmarks = bookmarks.filter(function (b) { return b.url !== tab.url; });
    } else {
      bookmarks.push({ title: tab.title || hostOf(tab.url), url: tab.url });
    }
    save('px.bookmarks', bookmarks);
    renderBookmarks();
    syncChrome();
  }

  function renderBookmarks() {
    els.bookmarks.textContent = '';
    bookmarks.forEach(function (mark) {
      var button = document.createElement('button');
      button.className = 'bookmark';
      button.title = mark.url + '  (right-click to remove)';

      var icon = document.createElement('img');
      icon.src = faviconFor(mark.url);
      icon.addEventListener('error', function () { icon.remove(); });

      var label = document.createElement('span');
      label.textContent = mark.title || hostOf(mark.url);

      button.append(icon, label);
      button.addEventListener('click', function () { navigate(mark.url, { raw: true }); });
      button.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        bookmarks = bookmarks.filter(function (b) { return b.url !== mark.url; });
        save('px.bookmarks', bookmarks);
        renderBookmarks();
        syncChrome();
      });
      els.bookmarks.appendChild(button);
    });
    renderShortcuts();
  }

  function renderShortcuts() {
    els.shortcuts.textContent = '';
    bookmarks.slice(0, 12).forEach(function (mark) {
      var button = document.createElement('button');
      button.className = 'shortcut';
      var glyph = document.createElement('span');
      glyph.textContent = (mark.title || hostOf(mark.url) || '?').charAt(0).toUpperCase();
      var label = document.createElement('span');
      label.textContent = mark.title || hostOf(mark.url);
      button.append(glyph, label);
      button.addEventListener('click', function () { navigate(mark.url, { raw: true }); });
      els.shortcuts.appendChild(button);
    });
  }

  /* ----------------------------------------------------------- persistence */

  var persistTimer = null;
  function persist() {
    if (!prefs.restore) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      save('px.session', {
        activeId: activeId,
        tabs: tabs.map(function (t) {
          return { id: t.id, title: t.title, url: t.url, history: t.history, index: t.index };
        }),
      });
    }, 400);
  }

  function restoreSession() {
    var session = prefs.restore ? load('px.session', null) : null;
    if (!session || !session.tabs || !session.tabs.length) return false;

    session.tabs.forEach(function (saved) {
      var tab = {
        id: nextId++,
        title: saved.title || 'New tab',
        url: saved.url || '',
        history: saved.history || [],
        index: typeof saved.index === 'number' ? saved.index : -1,
        loading: false,
        frame: null,
      };
      tabs.push(tab);
      if (saved.id === session.activeId) activeId = tab.id;
    });
    if (!activeId && tabs.length) activeId = tabs[0].id;

    // Only the visible tab loads now; the rest wake up when selected.
    tabs.forEach(function (tab) {
      if (tab.url) loadIntoFrame(tab, tab.url);
    });
    return true;
  }

  /* -------------------------------------------------------------- events */

  els.newtab.addEventListener('click', function () {
    createTab('');
    els.address.focus();
  });
  els.back.addEventListener('click', goBack);
  els.forward.addEventListener('click', goForward);
  els.reload.addEventListener('click', reload);
  els.home.addEventListener('click', function () {
    var tab = activeTab();
    if (!tab) return;
    tab.url = '';
    tab.title = 'New tab';
    tab.history = [];
    tab.index = -1;
    if (tab.frame) { tab.frame.remove(); tab.frame = null; }
    renderTabs();
    syncChrome();
    els.newtabInput.focus();
  });

  els.address.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      navigate(els.address.value);
      els.address.blur();
    } else if (event.key === 'Escape') {
      syncChrome();
      els.address.blur();
    }
  });
  els.address.addEventListener('focus', function () { els.address.select(); });

  els.bookmark.addEventListener('click', toggleBookmark);

  els.newtabForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = els.newtabInput.value.trim();
    if (!value) return;
    els.newtabInput.value = '';
    navigate(value);
  });

  els.settingsBtn.addEventListener('click', function () {
    els.engine.value = prefs.engine;
    els.restore.checked = !!prefs.restore;
    els.settings.showModal();
  });
  els.settingsClose.addEventListener('click', function () { els.settings.close(); });
  els.engine.addEventListener('change', function () {
    prefs.engine = els.engine.value;
    save('px.prefs', prefs);
  });
  els.restore.addEventListener('change', function () {
    prefs.restore = els.restore.checked;
    save('px.prefs', prefs);
    if (!prefs.restore) save('px.session', null);
  });
  els.clearData.addEventListener('click', function () {
    fetch('/__px/clear-data', { method: 'POST' }).then(function () {
      els.clearData.textContent = 'Cleared ✓';
      setTimeout(function () { els.clearData.textContent = 'Clear cookies & site data'; }, 1600);
    });
  });

  // Messages from the hook inside each proxied page.
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || !data.pxFrame) return;

    var tab = tabs.find(function (t) { return t.frame && t.frame.contentWindow === event.source; });
    if (!tab) return;

    if (data.type === 'px:location') {
      setLoading(tab, false);
      if (data.title) tab.title = data.title;
      recordVisit(tab, data.url);
      renderTabs();
      if (tab.id === activeId) syncChrome();
    } else if (data.type === 'px:newtab' && data.url) {
      createTab(data.url ? resolveQuery(data.url) : '', { background: false });
    } else if (data.type === 'px:loading') {
      setLoading(tab, true);
      renderTabs();
      if (tab.id === activeId) syncChrome();
    } else if (data.type === 'px:shortcut') {
      handleShortcut(data.key, data.shift);
    }
  });

  function handleShortcut(key, shift) {
    if (key === 't') { createTab(''); els.address.focus(); }
    else if (key === 'w') { if (activeId) closeTab(activeId); }
    else if (key === 'l') { els.address.focus(); }
  }

  document.addEventListener('keydown', function (event) {
    var mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 't') { event.preventDefault(); createTab(''); els.address.focus(); }
    else if (mod && event.key.toLowerCase() === 'w') { event.preventDefault(); if (activeId) closeTab(activeId); }
    else if (mod && event.key.toLowerCase() === 'l') { event.preventDefault(); els.address.focus(); }
    else if (mod && event.key.toLowerCase() === 'r') { event.preventDefault(); reload(); }
    else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
    else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
    else if (mod && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      var index = event.key === '9' ? tabs.length - 1 : Number(event.key) - 1;
      if (tabs[index]) selectTab(tabs[index].id);
    }
  });

  window.addEventListener('beforeunload', function () {
    clearTimeout(persistTimer);
    if (prefs.restore) {
      save('px.session', {
        activeId: activeId,
        tabs: tabs.map(function (t) {
          return { id: t.id, title: t.title, url: t.url, history: t.history, index: t.index };
        }),
      });
    }
  });

  /* ---------------------------------------------------------------- start */

  renderBookmarks();
  if (!restoreSession()) createTab('');
  renderTabs();
  syncChrome();

  // ?url=... lets you deep-link straight into a site.
  var initial = new URLSearchParams(location.search).get('url');
  if (initial) navigate(initial);
  else if (!activeTab() || !activeTab().url) els.newtabInput.focus();
})();
