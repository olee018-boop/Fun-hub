// A tiny website used by the integration tests: enough moving parts (relative
// links, CSS, cookies, redirects, forms, CSP headers) to exercise the proxy.

import http from 'node:http';
import zlib from 'node:zlib';

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

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}
