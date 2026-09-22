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
cookies into one origin and blow past the 4 KB limit.

## Limits

Worth knowing before you file a bug:

- **WebSockets aren't proxied**, so live chat, collaborative editors and some
  dashboards won't update.
- **Google, and most big services, will fight this.** Bot detection, captchas
  and hard-coded origin checks are common. DuckDuckGo Lite is the most reliable
  search option.
- **Service workers are disabled** inside proxied pages — they'd install against
  the proxy's origin and intercept everything.
- **`window.location = 'https://other-site.com'` from a page's own script** can
  escape the proxy; `location` can't be patched from JavaScript. Links, forms
  and fetches are all covered.
- **Video streaming** mostly won't work: DRM and range-heavy players don't
  survive the round trip.

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

33 tests: URL resolution, HTML/CSS rewriting, the cookie jar, the private
address guard, and end-to-end runs of the real server against a fixture origin
(rewriting, redirects, cookie replay, POST bodies, charset transcoding, header
stripping and the referer fallback).
