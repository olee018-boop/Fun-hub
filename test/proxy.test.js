// End-to-end: a real Express app proxying a real origin server over HTTP.

process.env.NODE_ENV = 'test';
process.env.PROXY_ALLOW_PRIVATE = '1'; // the fixture origin lives on 127.0.0.1

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startOrigin } from './fixture-origin.js';

const { default: app, server: appServer } = await import('../server/index.js');

let origin;
let originServer;
let proxyServer;
let proxyBase;

before(async () => {
  const fixture = await startOrigin();
  origin = fixture.origin;
  originServer = fixture.server;

  // The exported http server (not app.listen) so the WebSocket relay is live.
  proxyServer = appServer;
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;
});

after(async () => {
  await new Promise((r) => proxyServer.close(r));
  await new Promise((r) => originServer.close(r));
});

/** Fetch through the proxy, carrying the session cookie like a browser would. */
function makeClient() {
  let sessionCookie = '';
  const request = async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (sessionCookie) headers.cookie = sessionCookie;
    const res = await fetch(proxyBase + path, { redirect: 'manual', ...options, headers });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const line of setCookie) {
      if (line.startsWith('__px_sid=')) sessionCookie = line.split(';')[0];
    }
    return res;
  };
  Object.defineProperty(request, 'sessionCookie', { get: () => sessionCookie });
  return request;
}

test('serves the browser shell at /', async () => {
  const res = await fetch(`${proxyBase}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Fun-hub Browser/);
  assert.match(html, /\/__px\/app\.js/);
});

test('serves the injected hook script', async () => {
  const res = await fetch(`${proxyBase}/__px/hook.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /__PX_HOOK_INSTALLED__/);
});

test('proxies a page and rewrites every reference', async () => {
  const res = await makeClient()(`/p/${origin}/`);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, new RegExp(`href="/p/${origin}/about\\.html"`), 'relative link');
  assert.match(html, new RegExp(`href="/p/${origin}/deep/page"`), 'root-relative link');
  assert.match(html, /href="\/p\/https:\/\/other\.example\/x"/, 'external link');
  assert.match(html, /href="mailto:a@b\.c"/, 'mailto untouched');
  assert.match(html, /src="\/p\/http:\/\/cdn\.example\/img\.png"/, 'protocol-relative src');
  assert.match(html, new RegExp(`srcset="/p/${origin}/a\\.png 1x, /p/${origin}/b\\.png 2x"`));
  assert.match(html, new RegExp(`action="/p/${origin}/submit"`));
  assert.match(html, new RegExp(`url\\('/p/${origin}/bg\\.png'\\)`), 'inline <style>');
  assert.doesNotMatch(html, /integrity=/);
  assert.match(html, /src="\/__px\/hook\.js"/);
});

test('strips framing and CSP headers so the page can load in the shell', async () => {
  const res = await makeClient()(`/p/${origin}/`);
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(res.headers.get('x-frame-options'), null);
  const forwarded = (res.headers.getSetCookie?.() || []).join(' ');
  assert.doesNotMatch(forwarded, /sid=abc123/, 'origin cookies must not reach the client');
  assert.equal(res.headers.get('x-px-url'), `${origin}/`);
});

test('rewrites stylesheets', async () => {
  const res = await makeClient()(`/p/${origin}/style.css`);
  const css = await res.text();
  assert.match(css, new RegExp(`@import "/p/${origin}/more\\.css"`));
  assert.match(css, new RegExp(`url\\(/p/${origin}/img/x\\.png\\)`));
});

test('keeps cookies server-side and replays them to the origin', async () => {
  const request = makeClient();
  const first = await request(`/p/${origin}/`);

  // The origin's cookie must never reach the real browser.
  const leaked = (first.headers.getSetCookie?.() || []).filter((c) => c.includes('sid=abc123'));
  assert.deepEqual(leaked, [], 'origin cookies must not be forwarded to the client');

  const who = await (await request(`/p/${origin}/whoami`)).json();
  assert.match(who.cookie, /sid=abc123/, 'cookie replayed upstream');
});

test('clear-data empties the jar', async () => {
  const request = makeClient();
  await request(`/p/${origin}/`);
  await request('/__px/clear-data', { method: 'POST' });
  const who = await (await request(`/p/${origin}/whoami`)).json();
  assert.equal(who.cookie, '');
});

test('rewrites redirects back into the proxy', async () => {
  const res = await makeClient()(`/p/${origin}/redirect`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/p/${origin}/deep/page`);
});

test('sends the origin a real Referer, not the proxy URL', async () => {
  const res = await makeClient()(`/p/${origin}/whoami`, {
    headers: { referer: `${proxyBase}/p/${origin}/` },
  });
  assert.equal((await res.json()).referer, `${origin}/`);
});

test('forwards POST bodies', async () => {
  const res = await makeClient()(`/p/${origin}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'q=hello',
  });
  assert.deepEqual(await res.json(), { method: 'POST', body: 'q=hello' });
});

test('decompresses, rewrites and re-serves gzipped HTML', async () => {
  const res = await makeClient()(`/p/${origin}/gzip`);
  const html = await res.text();
  assert.equal(res.headers.get('content-encoding'), null, 'stale content-encoding would corrupt the body');
  assert.match(html, new RegExp(`href="/p/${origin}/gzlink"`));
  assert.match(html, /<title>Gz<\/title>/);
});

test('streams binary responses untouched', async () => {
  const res = await makeClient()(`/p/${origin}/binary`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('transcodes non-UTF-8 documents', async () => {
  const res = await makeClient()(`/p/${origin}/latin1`);
  const html = await res.text();
  assert.match(res.headers.get('content-type'), /utf-8/);
  assert.match(html, /café/);
  assert.match(html, /naïve/);
});

test('passes upstream error statuses through', async () => {
  const res = await makeClient()(`/p/${origin}/missing`);
  assert.equal(res.status, 404);
});

test('bounces stray root-relative requests using the Referer', async () => {
  const res = await fetch(`${proxyBase}/api/data?x=1`, {
    redirect: 'manual',
    headers: { referer: `${proxyBase}/p/${origin}/deep/page` },
  });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `/p/${origin}/api/data?x=1`);
});

test('404s a stray request with no Referer to work from', async () => {
  const res = await fetch(`${proxyBase}/api/data`, { redirect: 'manual' });
  assert.equal(res.status, 404);
});

test('/__px/go turns typed text into a URL or a search', async () => {
  const asUrl = await fetch(`${proxyBase}/__px/go?q=${encodeURIComponent('example.com/path')}`, { redirect: 'manual' });
  assert.equal(asUrl.headers.get('location'), '/p/https://example.com/path');

  const asSearch = await fetch(`${proxyBase}/__px/go?q=${encodeURIComponent('how do proxies work')}`, { redirect: 'manual' });
  assert.equal(asSearch.headers.get('location'), '/p/https://duckduckgo.com/?q=how%20do%20proxies%20work');

  const withEngine = await fetch(`${proxyBase}/__px/go?engine=wikipedia&q=otter`, { redirect: 'manual' });
  assert.match(withEngine.headers.get('location'), /en\.wikipedia\.org/);
});

test('rejects a malformed proxy URL', async () => {
  const res = await fetch(`${proxyBase}/p/`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Bad proxy URL/);
});


/* ------------------------------------------------- media, range, lengths */

test('preserves content-length on streamed responses', async () => {
  const res = await makeClient()(`/p/${origin}/media`);
  assert.equal(res.headers.get('content-length'), '1000');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal((await res.arrayBuffer()).byteLength, 1000);
});

test('forwards Range requests and relays 206 responses', async () => {
  const res = await makeClient()(`/p/${origin}/media`, { headers: { range: 'bytes=10-19' } });
  assert.equal(res.status, 206, 'a media player needs the partial response');
  assert.equal(res.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(res.headers.get('content-length'), '10');
  assert.equal((await res.arrayBuffer()).byteLength, 10);
});

test('restates content-length after rewriting changes the body', async () => {
  const res = await makeClient()(`/p/${origin}/deep/page`);
  const body = await res.text();
  assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(body));
});

/* ------------------------------------------------------------- cookies */

test('only script-visible cookies are seeded into the page', async () => {
  const request = makeClient();
  await request(`/p/${origin}/setcookie`);
  const html = await (await request(`/p/${origin}/deep/page`)).text();

  const config = JSON.parse(html.match(/window\.__PX__=(\{.*?\});<\/script>/)[1]);
  const names = config.cookies.map((c) => c.name);
  assert.deepEqual(names, ['visible'], 'HttpOnly cookies must not be exposed to page scripts');
});

test('cookies set from page JavaScript reach the jar', async () => {
  const request = makeClient();
  await request(`/p/${origin}/`);
  const stored = await request('/__px/cookie', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${origin}/`, cookie: 'fromjs=1; Path=/' }),
  });
  assert.equal(stored.status, 200);

  const who = await (await request(`/p/${origin}/whoami`)).json();
  assert.match(who.cookie, /fromjs=1/);
});

test('rejects a malformed cookie sync', async () => {
  const res = await makeClient()('/__px/cookie', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'not a url', cookie: 'x=1' }),
  });
  assert.equal(res.status, 400);
});

/* ---------------------------------------------------------- websockets */

function wsOnce(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once('error', reject);
  });
}

test('relays WebSocket connections to the target', async () => {
  const wsBase = proxyBase.replace('http://', 'ws://');
  const socket = new WebSocket(`${wsBase}/ws/${origin.replace('http://', 'ws://')}/socket`);
  await wsOnce(socket, 'open');

  const greeting = await wsOnce(socket, 'message');
  assert.match(greeting.toString(), /^hello:/);

  socket.send('ping');
  const echoed = await wsOnce(socket, 'message');
  assert.equal(echoed.toString(), 'echo:ping');

  socket.close();
});

test('WebSocket relay carries the session cookie jar upstream', async () => {
  const request = makeClient();
  await request(`/p/${origin}/`); // the origin sets sid=abc123 on this session
  assert.ok(request.sessionCookie, 'the client should be holding a session id');

  const wsBase = proxyBase.replace('http://', 'ws://');
  const socket = new WebSocket(`${wsBase}/ws/${origin.replace('http://', 'ws://')}/socket`, {
    headers: { cookie: request.sessionCookie },
  });
  await wsOnce(socket, 'open');
  const greeting = (await wsOnce(socket, 'message')).toString();
  socket.close();
  assert.match(greeting, /sid=abc123/, 'the jar must follow the socket, or logged-in sockets fail');
});

test('refuses to relay a WebSocket to a bad path', async () => {
  const wsBase = proxyBase.replace('http://', 'ws://');
  const socket = new WebSocket(`${wsBase}/not-a-relay`);
  await assert.rejects(() => wsOnce(socket, 'open'));
});
