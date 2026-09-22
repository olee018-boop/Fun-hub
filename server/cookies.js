// A small server-side cookie jar, one per browser session.
//
// Cookies from proxied sites are never handed to the real browser: that would
// mix every site's cookies into one origin and blow past the browser's 4KB
// limit. Instead each UI session gets an opaque id and we keep its jar here.

const jars = new Map(); // sid -> Map<key, cookie>
const lastSeen = new Map(); // sid -> timestamp
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function jarFor(sid) {
  lastSeen.set(sid, Date.now());
  let jar = jars.get(sid);
  if (!jar) {
    jar = new Map();
    jars.set(sid, jar);
  }
  return jar;
}

function parseSetCookie(line, requestUrl) {
  const parts = String(line).split(';');
  const [rawPair, ...attrs] = parts;
  const eq = rawPair.indexOf('=');
  if (eq < 0) return null;
  const name = rawPair.slice(0, eq).trim();
  const value = rawPair.slice(eq + 1).trim();
  if (!name) return null;

  const cookie = {
    name,
    value,
    domain: requestUrl.hostname,
    hostOnly: true,
    path: defaultPath(requestUrl.pathname),
    expires: null,
    secure: false,
    httpOnly: false,
  };

  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain' && val) {
      cookie.domain = val.replace(/^\./, '').toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && val.startsWith('/')) {
      cookie.path = val;
    } else if (key === 'expires' && val) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = t;
    } else if (key === 'max-age' && val) {
      const secs = Number(val);
      if (!Number.isNaN(secs)) cookie.expires = Date.now() + secs * 1000;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    }
  }
  return cookie;
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx);
}

function domainMatches(cookie, hostname) {
  const host = hostname.toLowerCase();
  const domain = cookie.domain.toLowerCase();
  if (host === domain) return true;
  if (cookie.hostOnly) return false;
  return host.endsWith(`.${domain}`);
}

function pathMatches(cookiePath, requestPath) {
  const p = requestPath || '/';
  if (cookiePath === p) return true;
  if (!p.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || p[cookiePath.length] === '/';
}

/** Record Set-Cookie headers returned by a proxied response. */
export function storeCookies(sid, requestUrl, setCookieLines) {
  if (!sid || !setCookieLines || !setCookieLines.length) return;
  const jar = jarFor(sid);
  for (const line of setCookieLines) {
    const cookie = parseSetCookie(line, requestUrl);
    if (!cookie) continue;
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      jar.delete(key); // expired == deletion
    } else {
      jar.set(key, cookie);
    }
  }
}

/** Build the Cookie request header for an outgoing proxied request. */
export function cookieHeader(sid, requestUrl) {
  if (!sid) return '';
  const jar = jars.get(sid);
  if (!jar || !jar.size) return '';
  lastSeen.set(sid, Date.now());

  const now = Date.now();
  const matches = [];
  for (const [key, cookie] of jar) {
    if (cookie.expires !== null && cookie.expires <= now) {
      jar.delete(key);
      continue;
    }
    if (cookie.secure && requestUrl.protocol !== 'https:') continue;
    if (!domainMatches(cookie, requestUrl.hostname)) continue;
    if (!pathMatches(cookie.path, requestUrl.pathname)) continue;
    matches.push(cookie);
  }
  // Longer paths first, as the cookie spec requires.
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * The cookies a page's own JavaScript is allowed to see, for seeding
 * document.cookie inside the proxied page.
 */
export function scriptVisibleCookies(sid, requestUrl) {
  if (!sid) return [];
  const jar = jars.get(sid);
  if (!jar || !jar.size) return [];

  const now = Date.now();
  const out = [];
  for (const cookie of jar.values()) {
    if (cookie.httpOnly) continue;
    if (cookie.expires !== null && cookie.expires <= now) continue;
    if (cookie.secure && requestUrl.protocol !== 'https:') continue;
    if (!domainMatches(cookie, requestUrl.hostname)) continue;
    if (!pathMatches(cookie.path, requestUrl.pathname)) continue;
    out.push({ name: cookie.name, value: cookie.value });
  }
  return out;
}

/** Forget everything stored for a session ("clear browsing data"). */
export function clearJar(sid) {
  jars.delete(sid);
}

/** Drop jars for sessions nobody has used in a while. */
export function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, seen] of lastSeen) {
    if (seen < cutoff) {
      lastSeen.delete(sid);
      jars.delete(sid);
    }
  }
}
