// Helpers for translating between real URLs and proxied ("/p/<url>") URLs.

export const PREFIX = '/p/';

// Schemes we must never touch when rewriting a document.
const OPAQUE = /^(data:|blob:|javascript:|mailto:|tel:|about:|#|sms:|magnet:|intent:|ws:|wss:)/i;

/**
 * Browsers and URL resolvers happily collapse the "//" in a path segment, so a
 * proxied URL can come back to us as "/p/https:/example.com/x". Put it back.
 */
export function normalizeTarget(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^(https?:)\/{0,2}/i, (_m, scheme) => `${scheme.toLowerCase()}//`);
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  return s;
}

/** Extract the target URL from an incoming proxied request path. */
export function targetFromPath(originalUrl) {
  if (!originalUrl.startsWith(PREFIX)) return null;
  const raw = originalUrl.slice(PREFIX.length);
  if (!raw) return null;
  try {
    return new URL(normalizeTarget(decodeMaybe(raw)));
  } catch {
    return null;
  }
}

// The address bar sends fully encoded URLs; links inside pages are written
// unencoded so that relative resolution keeps working. Handle both.
function decodeMaybe(raw) {
  if (/^https?%3A/i.test(raw)) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Build the proxied path for an absolute URL. */
export function toProxy(absUrl) {
  return PREFIX + String(absUrl);
}

/**
 * Resolve a possibly-relative URL found in a document against its base and
 * return the proxied form. Returns null for values that must be left as-is.
 */
export function rewriteRef(value, base) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || OPAQUE.test(v)) return null;
  if (v.startsWith(PREFIX)) return null; // already proxied
  try {
    const abs = new URL(v, base);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    return toProxy(abs.href);
  } catch {
    return null;
  }
}

/** Rewrite a srcset / imagesrcset attribute value. */
export function rewriteSrcset(value, base) {
  return String(value)
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const [url, ...descriptors] = trimmed.split(/\s+/);
      const proxied = rewriteRef(url, base);
      return [proxied || url, ...descriptors].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}
