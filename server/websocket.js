// Proxies WebSocket connections: the page connects to /ws/<absolute-ws-url> on
// our origin and we relay frames to the real endpoint.
//
// Without this, every live feature on a modern site (chat, notifications,
// collaborative editing, dev servers) simply fails to connect.

import { WebSocketServer, WebSocket } from 'ws';
import { cookieHeader } from './cookies.js';
import { normalizeTarget } from './url.js';
import { assertPublicHost } from './guard.js';

export const WS_PREFIX = '/ws/';

/** Pull the target endpoint out of an upgrade request path. */
export function wsTargetFromPath(pathname) {
  if (!pathname.startsWith(WS_PREFIX)) return null;
  let raw = pathname.slice(WS_PREFIX.length);
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* use it as-is */
  }
  // Accept ws://, wss:// and the http(s) forms the hook may hand us.
  raw = raw.replace(/^(wss?:|https?:)\/{0,2}/i, (_m, scheme) => `${scheme.toLowerCase()}//`);
  if (!/^(wss?|https?):\/\//i.test(raw)) raw = `wss://${raw.replace(/^\/+/, '')}`;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    return url;
  } catch {
    return null;
  }
}

function sessionIdFrom(req) {
  const header = req.headers.cookie || '';
  const found = header
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('__px_sid='));
  const sid = found ? found.slice('__px_sid='.length) : '';
  return /^[a-f0-9]{32}$/.test(sid) ? sid : '';
}

/** Attach WebSocket relaying to an existing HTTP server. */
export function attachWebSocketProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const target = wsTargetFromPath(pathname);
    if (!target) {
      socket.destroy();
      return;
    }

    try {
      await assertPublicHost(target.hostname);
    } catch {
      socket.destroy();
      return;
    }

    // The target's cookies and Origin have to look like a same-site connection.
    const httpOrigin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`;
    const headers = { origin: httpOrigin };
    const cookies = cookieHeader(sessionIdFrom(req), new URL(httpOrigin));
    if (cookies) headers.cookie = cookies;
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

    const protocols = (req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    wss.handleUpgrade(req, socket, head, (client) => {
      relay(client, target, headers, protocols);
    });
  });

  return wss;
}

function relay(client, target, headers, protocols) {
  let upstream;
  try {
    upstream = new WebSocket(target.href, protocols, { headers, handshakeTimeout: 20_000 });
  } catch {
    client.close(1011, 'upstream connect failed');
    return;
  }

  const pending = [];
  let open = false;

  upstream.on('open', () => {
    open = true;
    for (const message of pending.splice(0)) upstream.send(message);
  });

  // Frames can arrive before the upstream handshake finishes; queue them.
  client.on('message', (data, isBinary) => {
    const payload = isBinary ? data : data.toString();
    if (open) upstream.send(payload);
    else pending.push(payload);
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === client.OPEN) client.send(isBinary ? data : data.toString());
  });

  const shutdown = (socket) => (code, reason) => {
    const valid = typeof code === 'number' && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006;
    try {
      socket.close(valid ? code : 1000, reason ? reason.toString().slice(0, 120) : '');
    } catch {
      socket.terminate?.();
    }
  };

  client.on('close', shutdown(upstream));
  upstream.on('close', shutdown(client));
  client.on('error', () => upstream.terminate());
  upstream.on('error', () => {
    if (client.readyState === client.OPEN) client.close(1011, 'upstream error');
    else client.terminate();
  });
}
