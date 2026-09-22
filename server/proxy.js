// The proxy endpoint: fetch the target, sanitise headers, rewrite the body.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import iconv from 'iconv-lite';
import { cookieHeader, storeCookies, scriptVisibleCookies } from './cookies.js';
import { rewriteCss, rewriteHtml, rewriteLocation } from './rewrite.js';
import { targetFromPath, toProxy } from './url.js';
import { assertPublicHost } from './guard.js';

const MAX_REWRITE_BYTES = 12 * 1024 * 1024;

// Headers that describe the client's connection to *us*, not to the target.
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'cookie', 'content-length',
  'accept-encoding', 'origin', 'referer', 'if-none-match', 'if-modified-since',
]);

// Media players depend on these surviving the round trip.
const PASSTHROUGH_REQUEST = ['range', 'if-range'];

// Headers that would either break framing or undo our rewriting.
const STRIP_RESPONSE = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'content-encoding', 'set-cookie',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'report-to', 'nel', 'permissions-policy', 'feature-policy', 'x-xss-protection',
  'clear-site-data', 'alt-svc', 'transfer-encoding', 'connection',
]);

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function contentKind(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/css') return 'css';
  return 'other';
}

function charsetOf(contentType, body) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (match) return match[1].toLowerCase();
  if (body) {
    // Sniff a <meta charset> from the first chunk of the document.
    const head = body.subarray(0, 2048).toString('latin1');
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
    if (meta) return meta[1].toLowerCase();
  }
  return 'utf-8';
}

function decode(buffer, charset) {
  if (!charset || /^utf-?8$/i.test(charset)) return buffer.toString('utf8');
  if (iconv.encodingExists(charset)) return iconv.decode(buffer, charset);
  return buffer.toString('utf8');
}

/** Turn the incoming browser request into headers for the target server. */
function buildRequestHeaders(req, target, sid) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) headers[name] = value.join(', ');
    else if (value != null) headers[name] = value;
  }
  headers['user-agent'] = req.headers['user-agent'] || DEFAULT_UA;
  headers['accept-encoding'] = 'gzip, deflate, br';
  for (const name of PASSTHROUGH_REQUEST) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  // Rewrite Referer/Origin to the values the target expects to see.
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refTarget = targetFromPath(new URL(referer).pathname + new URL(referer).search);
      if (refTarget) {
        headers.referer = refTarget.href;
        headers.origin = refTarget.origin;
      }
    } catch {
      /* unparseable referer: send none */
    }
  }
  if (!headers.origin && req.method !== 'GET' && req.method !== 'HEAD') {
    headers.origin = target.origin;
  }

  const cookies = cookieHeader(sid, target);
  if (cookies) headers.cookie = cookies;
  return headers;
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * Entry point. Everything below can fail on a hostile or simply unlucky
 * response, and a browser proxy must never die because one page misbehaved.
 */
export async function handleProxy(req, res) {
  try {
    await proxyRequest(req, res);
  } catch (err) {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    const target = targetFromPath(req.originalUrl);
    res.status(502).type('text/html').send(errorPage(target ? target.href : req.originalUrl, err.message));
  }
}

async function proxyRequest(req, res) {
  const target = targetFromPath(req.originalUrl);
  if (!target) {
    res.status(400).type('text/plain').send('Bad proxy URL.');
    return;
  }

  try {
    await assertPublicHost(target.hostname);
  } catch (err) {
    res.status(403).type('text/plain').send(`Blocked: ${err.message}`);
    return;
  }

  const sid = req.pxSessionId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  res.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: req.method,
      headers: buildRequestHeaders(req, target, sid),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.pxBody,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (res.headersSent || res.writableEnded) return;
    const reason = err.name === 'AbortError' ? 'The request timed out.' : err.message;
    res.status(502).type('text/html').send(errorPage(target.href, reason));
    return;
  }
  clearTimeout(timeout);

  storeCookies(sid, target, getSetCookies(upstream));

  // Copy through everything that isn't dangerous.
  for (const [name, value] of upstream.headers) {
    if (STRIP_RESPONSE.has(name.toLowerCase())) continue;
    try {
      res.setHeader(name, value);
    } catch {
      /* a header Node refuses to send on: dropping it beats failing the page */
    }
  }
  res.setHeader('x-px-url', encodeURI(target.href));

  // undici already decompressed the body, so any upstream length is now a lie.
  if (upstream.headers.get('content-encoding')) res.removeHeader('content-length');

  const location = upstream.headers.get('location');
  if (location && upstream.status >= 300 && upstream.status < 400) {
    res.status(upstream.status);
    res.setHeader('location', rewriteLocation(location, target.href));
    res.end();
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  const kind = contentKind(contentType);
  res.status(upstream.status >= 100 && upstream.status <= 599 ? upstream.status : 502);

  if (!upstream.body) {
    res.end();
    return;
  }

  // Binary and script responses stream straight through untouched.
  //
  // pipeline(), not pipe(): navigating away mid-download aborts this stream,
  // and pipe() leaves that 'error' event unhandled, which takes the whole
  // process down. Routine browsing does this constantly.
  if (kind === 'other') {
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(await upstream.arrayBuffer());
  } catch {
    res.end();
    return;
  }

  if (buffer.byteLength > MAX_REWRITE_BYTES) {
    res.setHeader('content-length', String(buffer.byteLength));
    res.end(buffer); // too big to parse; better to serve it as-is
    return;
  }

  const charset = charsetOf(contentType, buffer);
  const text = decode(buffer, charset);
  let output;
  try {
    output =
      kind === 'html'
        ? rewriteHtml(text, target.href, { cookies: scriptVisibleCookies(sid, target) })
        : rewriteCss(text, target.href);
  } catch (err) {
    output = text; // never fail the page over a rewriting bug
  }

  // We always emit UTF-8 once we've decoded and re-serialised, and the body
  // changed length, so restate it rather than leaving a stale value behind.
  const body = Buffer.from(output, 'utf8');
  res.setHeader('content-type', `${contentType.split(';')[0].trim() || 'text/html'}; charset=utf-8`);
  res.setHeader('content-length', String(body.byteLength));
  res.end(body);
}

export function errorPage(url, reason) {
  const safe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>Can't reach this page</title>
<style>
  :root{color-scheme:dark light}
  body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;
       background:#14161a;color:#e6e8eb}
  .card{max-width:34rem;padding:2.5rem;text-align:center}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  code{background:#22262c;padding:.15rem .4rem;border-radius:4px;word-break:break-all}
  p{color:#9aa4b2}
</style>
<div class="card">
  <h1>Can't reach this page</h1>
  <p><code>${safe(url)}</code></p>
  <p>${safe(reason)}</p>
</div>`;
}

/**
 * Last-resort handler for requests that escaped rewriting — typically a root
 * relative URL like "/api/x" requested by a script we couldn't patch. The
 * Referer tells us which site it belongs to, so bounce it to the right place.
 */
export function refererFallback(req, res, next) {
  const referer = req.headers.referer;
  if (!referer) return next();
  let refTarget;
  try {
    const parsed = new URL(referer);
    refTarget = targetFromPath(parsed.pathname + parsed.search);
  } catch {
    return next();
  }
  if (!refTarget) return next();
  const resolved = new URL(req.originalUrl, refTarget.href);
  res.redirect(307, toProxy(resolved.href));
}
