import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { handleProxy, refererFallback } from './proxy.js';
import { clearJar, sweepSessions, storeCookies } from './cookies.js';
import { attachWebSocketProxy } from './websocket.js';
import { PREFIX, normalizeTarget, toProxy } from './url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_COOKIE = '__px_sid';
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

/** Give each browser session its own cookie jar on the server. */
app.use((req, res, next) => {
  const header = req.headers.cookie || '';
  const found = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));

  let sid = found ? found.slice(SESSION_COOKIE.length + 1) : '';
  if (!/^[a-f0-9]{32}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    });
  }
  req.pxSessionId = sid;
  next();
});

/** Buffer request bodies so they can be replayed upstream. */
app.use(PREFIX, (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.status(413).type('text/plain').send('Request body too large.');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    req.pxBody = chunks.length ? Buffer.concat(chunks) : undefined;
    next();
  });
  req.on('error', () => next());
});

// --- browser shell ---------------------------------------------------------

app.use(
  '/__px',
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1h',
    setHeaders: (res) => res.setHeader('cache-control', 'public, max-age=3600'),
  })
);

app.post('/__px/clear-data', (req, res) => {
  clearJar(req.pxSessionId);
  res.json({ ok: true });
});

app.get('/__px/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/**
 * Cookies a page sets from JavaScript. The hook posts them here so they join
 * the session jar and get replayed on later requests to that site.
 */
app.post('/__px/cookie', express.json({ limit: '64kb' }), (req, res) => {
  const { url, cookie } = req.body || {};
  if (typeof url !== 'string' || typeof cookie !== 'string' || !cookie) {
    return res.status(400).json({ ok: false });
  }
  try {
    storeCookies(req.pxSessionId, new URL(url), [cookie]);
  } catch {
    return res.status(400).json({ ok: false });
  }
  res.json({ ok: true });
});

/**
 * Turn whatever the user typed into a URL and bounce to it. Anything that
 * doesn't look like a hostname becomes a search.
 */
app.get('/__px/go', (req, res) => {
  const query = String(req.query.q || '').trim();
  const engine = String(req.query.engine || 'duckduckgo');
  if (!query) return res.redirect('/');
  res.redirect(toProxy(resolveQuery(query, engine)));
});

const ENGINES = {
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  'duckduckgo-lite': (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
};

// A single token with a dot and no spaces is a hostname; everything else is a
// search. "localhost:3000" and "1.2.3.4" count as hostnames too.
const LOOKS_LIKE_HOST = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i;

export function resolveQuery(input, engine = 'duckduckgo') {
  const q = input.trim();
  if (/^https?:\/\//i.test(q)) return normalizeTarget(q);
  if (!/\s/.test(q) && (LOOKS_LIKE_HOST.test(q) || /^localhost(:\d+)?([/?#]|$)/i.test(q))) {
    return normalizeTarget(q);
  }
  const build = ENGINES[engine] || ENGINES.duckduckgo;
  return build(q);
}

// --- the proxy itself ------------------------------------------------------

app.all(`${PREFIX}*`, handleProxy);

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Requests from proxied pages that lost their prefix get bounced back on track.
app.use(refererFallback);

app.use((_req, res) => res.status(404).type('text/plain').send('Not found.'));

setInterval(sweepSessions, 30 * 60 * 1000).unref();

export const server = http.createServer(app);
attachWebSocketProxy(server);

if (process.env.NODE_ENV !== 'test') {
  // The devcontainer already starts the server on attach, so running
  // `npm start` by hand is a normal thing to do and shouldn't dump a stack
  // trace on someone who just wants to know what happened.
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(
      `\n  Port ${PORT} is already in use — Fun-hub is most likely already running.\n` +
        `\n  To open it:      Ports tab → click the globe icon on port ${PORT}` +
        `\n  To restart it:   npm run restart` +
        `\n  To run a second: PORT=3001 npm start\n`
    );
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  Fun-hub Browser is running\n  → http://localhost:${PORT}\n`);
    if (process.env.CODESPACE_NAME) {
      const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
      console.log(`  Codespace URL: https://${process.env.CODESPACE_NAME}-${PORT}.${domain}\n`);
    }
  });
}

export default app;
