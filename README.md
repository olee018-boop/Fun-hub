# 🌐 Fun-hub Browser

A self-hosted web proxy with a real browser interface. Run it in a GitHub
Codespace, open the forwarded port, and you get a tabbed browser — address bar,
search, back/forward, bookmarks, the lot — where every page is fetched by the
server and rewritten so it renders inside the app.

## Run it in a Codespace

1. On the GitHub repo page, click **Code → Codespaces → Create codespace on main**.
2. Wait for the container to build. `npm install` runs automatically, then
   `npm start`.
3. A **Ports** notification appears for port 3000 — click **Open in Browser**
   (or open the **Ports** tab and click the globe icon next to port 3000).
4. Start browsing.

If the preview doesn't pop up on its own, open the **Ports** panel, find port
3000 and open its forwarded URL.

## Run it locally

```bash
git clone https://github.com/olee018-boop/Fun-hub.git
cd Fun-hub
npm install
npm start
```

Then open <http://localhost:3000>.

`npm run dev` restarts the server when you edit a file. `npm test` runs the
suite.

## What it does

| | |
|---|---|
| **Tabs** | Open, close, switch, middle-click to close, `Ctrl+1…9` to jump |
| **Address bar** | Type a URL or a search — it works out which you meant |
| **Search** | DuckDuckGo by default; Bing, Google, Wikipedia and DDG Lite in settings |
| **History** | Per-tab back and forward, including links followed inside a page |
| **Bookmarks** | Star the current page; right-click a bookmark to remove it |
| **Session restore** | Your tabs come back when you reload the app |
| **Cookies** | Kept per session on the server, so sites keep you logged in |
| **WebSockets** | Relayed through the server, so live features work |
| **Streaming** | SSE and streamed responses pass through incrementally |
| **Loading UI** | Spinner, progress bar and a spinning tab favicon while a page loads |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+L` | Focus the address bar |
| `Ctrl+R` | Reload |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl+1`…`Ctrl+8` | Jump to tab · `Ctrl+9` last tab |

## How it works

```
browser ──▶ shell (public/)  ──▶  iframe  ──▶  /p/<url>  ──▶  target site
                 tabs, omnibox            proxy: fetch, sanitise, rewrite
```

Everything the page loads is addressed as `/p/<absolute-url>`, so the whole
session stays on one origin and the iframe stays same-origin with the shell —
that's what lets the UI read each tab's title and drive its history.

**`server/proxy.js`** fetches the target, drops the headers that would break
framing (`Content-Security-Policy`, `X-Frame-Options`, the `Cross-Origin-*`
family), rewrites redirects, and hands HTML and CSS to the rewriter. Everything
else streams through untouched.

**`server/rewrite.js`** rewrites `href`, `src`, `srcset`, `action`, `url()`,
`@import`, `<base>` and `<meta http-equiv>`, drops `integrity` attributes that
can no longer match, and injects the runtime hook at the very top of `<head>`.

**`public/hook.js`** is that hook. Static rewriting can't see URLs a page builds
at runtime, so inside every proxied page it patches `fetch`, `XMLHttpRequest`,
`sendBeacon`, `EventSource`, `Worker`, `setAttribute`, the reflected `.src` /
`.href` properties, `history.pushState`, `window.open` and form submission, and
watches the DOM for nodes added later. It also reports each page's title and URL
up to the shell.

**`server/cookies.js`** keeps a cookie jar per UI session, server-side. Site
cookies are never handed to your real browser — that would mix every site's
cookies into one origin and blow past the 4 KB limit. Cookies a page sets from
JavaScript are namespaced per site and mirrored back to the jar, so one site
can't read or clobber another's.

**`server/websocket.js`** relays WebSocket connections. A page connecting to
`wss://site/socket` is rewritten to `/ws/wss://site/socket` on our origin, and
the server bridges the two, carrying the session's cookies upstream.

One subtlety worth knowing: a page that builds a URL from `location.host` or
`new URL(path, location.href)` would get the *proxy's* address, losing the site
entirely. The hook resolves those against the real URL instead, which is what
makes most single-page apps work.

## What works, and what doesn't

This is a rewriting proxy. It fetches pages on the server and edits them so they
render on a different origin than they were built for. That works well for a
large part of the web and badly for a specific, predictable slice of it.

**Works well** — documentation, wikis, news, blogs, forums, search engines,
most static and server-rendered sites, and simple interactive apps.

**Usually works** — single-page apps. Navigation, `fetch`/XHR, WebSockets,
server-sent events and dynamically built DOM are all handled. Streaming is
genuinely incremental: a chat app's reply arrives token by token, not in one
lump at the end. Expect occasional rough edges.

**Often fails** — sites behind bot protection. **ChatGPT is the typical case.**
The transport it needs is all supported here (POST returning a stream, SSE,
WebSockets), but `chatgpt.com` sits behind Cloudflare bot management, which
fingerprints the TLS handshake and scores datacenter IPs harshly. Requests from
this proxy come from Node, whose TLS fingerprint looks nothing like Chrome's,
from a cloud IP — so you will most likely get a "Verify you are human" challenge
that cannot be completed. Defeating that is not something this project tries to
do. The same applies to most sites fronted by Cloudflare's stricter modes, and
to Google properties.

**Won't work** — large streaming services. **YouTube is the clearest example,
and it is not a bug we can fix:**

- **Playback uses Media Source Extensions** — the player fetches video segments
  from `googlevideo.com` URLs signed against your session and IP. Relaying those
  through a proxy invalidates them or throttles them to unusable speeds.
- **Bot detection targets datacenter IPs.** A Codespace runs in Azure. YouTube
  frequently answers those with "Sign in to confirm you're not a bot" before any
  proxying question arises.
- **Some content is DRM-protected** (Widevine/EME), which cannot work in a
  rewritten, reframed page.
- **Volume.** A single YouTube page-load is hundreds of requests, all funnelled
  through one Node process.

Netflix, Spotify, Twitch and similar are the same story. If you want video in a
Codespace, a proxy is the wrong tool.

### Remaining known gaps

- **`window.location = 'https://other-site.com'` from a page's own script** can
  escape the proxy. `location` is unforgeable in JavaScript, so it cannot be
  patched. Links, forms, `fetch`, XHR, WebSockets and URLs built from
  `location.host` are all handled; direct assignment of a cross-origin absolute
  URL is not.
- **Service workers are disabled** inside proxied pages — they would install
  against the proxy's origin and intercept everything.
- **`localStorage` is shared** between all proxied sites, because they all run
  on this one origin. Cookies are namespaced per site; `localStorage` is not.
- **`<iframe srcdoc>` content** isn't rewritten.
- **Captchas** mostly won't complete.

## Security

The proxy refuses to fetch private and loopback addresses — `localhost`,
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`
(cloud metadata) and their IPv6 equivalents — checked after DNS resolution, so a
public hostname pointing at an internal IP is blocked too. Without that, anyone
who could reach the UI could read services running inside your Codespace.

Set `PROXY_ALLOW_PRIVATE=1` to turn that off when you deliberately want to proxy
something on your own network.

Codespaces forwards ports privately by default, so only you can reach it. **If
you set the port to public, anyone with the URL can browse through your
Codespace** — it becomes an open proxy with your cookie jar. Don't.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PROXY_ALLOW_PRIVATE` | unset | `1` allows proxying private/loopback addresses |

## Project layout

```
server/
  index.js     Express app, routes, session cookie, body buffering
  proxy.js     fetch the target, sanitise headers, dispatch to the rewriter
  rewrite.js   HTML and CSS rewriting, hook injection
  url.js       /p/<url> encoding and reference resolution
  cookies.js   per-session server-side cookie jar
  websocket.js WebSocket relay
  guard.js     private-address blocking
public/
  index.html   the browser shell
  app.js       tabs, history, omnibox, bookmarks
  styles.css   theme
  hook.js      injected into every proxied page
test/          unit and end-to-end tests
```

## Tests

```bash
npm test
```

44 tests: URL resolution, HTML/CSS rewriting, the cookie jar, the private
address guard, and end-to-end runs of the real server against a fixture origin
(rewriting, redirects, cookie replay, POST bodies, charset transcoding, gzip,
range requests, `content-length` handling, WebSocket relaying, SSE streaming,
header stripping and the referer fallback).
