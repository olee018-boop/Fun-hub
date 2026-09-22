// The proxy runs as a long-lived process serving a whole browsing session.
// A single bad response must never take it down, so these tests run the real
// server as a child process and check it is still alive afterwards.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

let origin;
let originPort;
let child;
let port;
let exited = null;
let stderr = '';

const openSockets = new Set();

/** Track every socket so shutdown can be unconditional. */
function track(httpServer) {
  httpServer.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  return httpServer;
}

/** An origin that dribbles out a large body, the way an image or video does. */
function startSlowOrigin() {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5000000' });
    let sent = 0;
    const timer = setInterval(() => {
      if (!res.writable) return clearInterval(timer);
      res.write(Buffer.alloc(50_000));
      sent += 50_000;
      if (sent >= 5_000_000) {
        clearInterval(timer);
        res.end();
      }
    }, 40);
    req.on('close', () => clearInterval(timer));
  });
  track(origin);
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () => {
      originPort = origin.address().port;
      resolve();
    });
  });
}

before(async () => {
  await startSlowOrigin();
  port = 3600 + Math.floor(Math.random() * 300);

  child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), PROXY_ALLOW_PRIVATE: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('exit', (code) => { exited = code; });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  // Wait for it to accept connections.
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (exited !== null) throw new Error(`server exited early with code ${exited}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__px/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server never became ready');
    await new Promise((r) => setTimeout(r, 120));
  }
});

/** close() alone waits for in-flight sockets, and this origin never stops
 *  dribbling — so drop the connections first or the runner hangs on exit. */
function shutdown(httpServer) {
  httpServer.closeAllConnections?.();
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  return new Promise((resolve) => httpServer.close(resolve));
}

after(async () => {
  child?.kill('SIGKILL');
  await shutdown(origin);
});

const alive = () => exited === null;

// A crashed server leaves sockets hanging, so never wait on one indefinitely.
const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });

test('survives a download the client abandons mid-stream', { timeout: 20_000 }, async () => {
  // Exactly what a browser does when you navigate away while an image, script
  // or video is still loading. This used to kill the process outright: the
  // aborted upstream body emitted an unhandled 'error' event.
  for (let i = 0; i < 5; i++) {
    const controller = new AbortController();
    // If the server dies mid-stream the read never settles, so cap it: the
    // test must fail, not hang, when this regresses.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    const request = fetch(`http://127.0.0.1:${port}/p/http://127.0.0.1:${originPort}/big${i}.png`, {
      signal,
    }).then(async (res) => {
      const reader = res.body.getReader();
      await reader.read(); // take one chunk, then walk away
      controller.abort();
    });
    await request.catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 600));
  assert.ok(alive(), `server died after aborted downloads (exit code ${exited})`);

  const health = await get('/__px/health');
  assert.equal(health.status, 200, 'server should still be serving');

  // Staying up is not enough. The process-level handler is a safety net, and a
  // net that is catching things means the stream path is still broken — so
  // require that nothing reached it.
  assert.doesNotMatch(
    stderr,
    /uncaught exception/i,
    `an aborted download must be handled where it happens, not rescued by the last-resort handler:\n${stderr}`
  );
});

test('survives an origin that vanishes mid-response', { timeout: 20_000 }, async () => {
  const flaky = track(http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100000' });
    res.write(Buffer.alloc(1000));
    setTimeout(() => res.socket.destroy(), 80); // hang up without finishing
  }));
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  const flakyPort = flaky.address().port;

  await get(`/p/http://127.0.0.1:${flakyPort}/x.bin`)
    .then((r) => r.arrayBuffer())
    .catch(() => {});

  await new Promise((r) => setTimeout(r, 400));
  assert.ok(alive(), `server died when the origin hung up (exit code ${exited})`);
  assert.equal((await get('/__px/health')).status, 200);
  assert.doesNotMatch(stderr, /uncaught exception/i, `origin hangups must be handled cleanly:\n${stderr}`);
  await shutdown(flaky);
});

test('returns an error page instead of dying when the origin refuses', { timeout: 20_000 }, async () => {
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await shutdown(dead); // nothing is listening now

  const res = await get(`/p/http://127.0.0.1:${deadPort}/`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Can't reach this page/);
  assert.ok(alive(), 'a refused connection must not be fatal');
});
