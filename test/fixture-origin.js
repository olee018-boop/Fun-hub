// A tiny website used by the integration tests: enough moving parts (relative
// links, CSS, cookies, redirects, forms, CSP headers) to exercise the proxy.

import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';

export function startOrigin() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
        'set-cookie': 'sid=abc123; Path=/; HttpOnly',
      });
      res.end(`<!doctype html><html><head><title>Fixture Home</title>
<link rel="stylesheet" href="/style.css">
<style>body{background:url('/bg.png')}</style>
</head><body>
<a id="rel" href="about.html">About</a>
<a id="abs" href="/deep/page">Deep</a>
<a id="ext" href="https://other.example/x">External</a>
<a id="mail" href="mailto:a@b.c">Mail</a>
<img src="//cdn.example/img.png" srcset="/a.png 1x, /b.png 2x">
<script src="/app.js" integrity="sha384-xyz"></script>
<form action="/submit" method="post"><input name="q"></form>
</body></html>`);
      return;
    }

    if (url.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('@import "/more.css";\n.a{background:url(/img/x.png)}');
      return;
    }

    if (url.pathname === '/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cookie: req.headers.cookie || '', referer: req.headers.referer || '' }));
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/deep/page' });
      res.end();
      return;
    }

    if (url.pathname === '/deep/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Deep</title></head><body><a href="sibling">Sibling</a></body></html>');
      return;
    }

    if (url.pathname === '/submit' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: 'POST', body }));
      });
      return;
    }

    if (url.pathname === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.from('<html><head><title>caf\xe9</title></head><body>na\xefve</body></html>', 'latin1'));
      return;
    }

    // A single-page app doing the thing that breaks naive proxies: building a
    // URL against location.href and fetching it.
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Slow</title></head><body>done</body></html>');
      }, 1500);
      return;
    }

    if (url.pathname === '/wsdemo') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>WS</title></head><body>
<script>
  window.__ws = {};
  var s = new WebSocket('ws://' + location.host + '/socket');
  s.onopen = function () { window.__ws.open = true; s.send('ping'); };
  s.onmessage = function (e) {
    window.__ws.messages = (window.__ws.messages || []).concat(e.data);
  };
  s.onerror = function () { window.__ws.error = true; };
</script>
</body></html>`);
      return;
    }

    if (url.pathname === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>SPA</title></head><body>
<div id="out">pending</div>
<script>
  window.__probe = {};
  var built = new URL('/api/data', location.href);
  window.__probe.builtHref = built.href;
  window.__probe.builtHost = built.hostname;
  fetch(built).then(function (r) { return r.json(); }).then(function (j) {
    window.__probe.fetched = j.ok;
    document.getElementById('out').textContent = 'loaded';
  }).catch(function (e) { window.__probe.fetched = 'error: ' + e.message; });
</script>
</body></html>`);
      return;
    }

    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
      return;
    }

    // Range support, as a media player would use.
    if (url.pathname === '/media') {
      const payload = Buffer.alloc(1000, 0x41);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : payload.length - 1;
        const slice = payload.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${payload.length}`,
          'content-length': String(slice.length),
          'accept-ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(payload.length),
        'accept-ranges': 'bytes',
      });
      res.end(payload);
      return;
    }

    if (url.pathname === '/setcookie') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['visible=yes; Path=/', 'hidden=nope; Path=/; HttpOnly'],
      });
      res.end('<html><head><title>Cookies</title></head><body>ok</body></html>');
      return;
    }

    if (url.pathname === '/gzip') {
      const body = zlib.gzipSync(Buffer.from('<html><head><title>Gz</title></head><body><a href="/gzlink">g</a></body></html>'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(body);
      return;
    }

    if (url.pathname === '/binary') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });

  // Echo endpoint for the WebSocket relay tests.
  const wss = new WebSocketServer({ server, path: '/socket' });
  wss.on('connection', (socket, req) => {
    socket.send(`hello:${req.headers.cookie || 'nocookie'}`);
    socket.on('message', (data) => socket.send(`echo:${data}`));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, wss, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}
