import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTarget, targetFromPath, rewriteRef, rewriteSrcset, toProxy } from '../server/url.js';
import { rewriteHtml, rewriteCss, rewriteLocation } from '../server/rewrite.js';
import { isPrivateAddress, assertPublicHost } from '../server/guard.js';
import { storeCookies, cookieHeader, clearJar } from '../server/cookies.js';

test('normalizeTarget repairs collapsed and bare URLs', () => {
  assert.equal(normalizeTarget('https:/example.com/a'), 'https://example.com/a');
  assert.equal(normalizeTarget('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeTarget('example.com'), 'https://example.com');
  assert.equal(normalizeTarget('HTTP://Example.com'), 'http://Example.com');
});

test('targetFromPath reads both raw and encoded proxy paths', () => {
  assert.equal(targetFromPath('/p/https://example.com/a?b=1').href, 'https://example.com/a?b=1');
  assert.equal(targetFromPath(`/p/${encodeURIComponent('https://example.com/a?b=1')}`).href, 'https://example.com/a?b=1');
  assert.equal(targetFromPath('/p/https:/example.com/a').href, 'https://example.com/a');
  assert.equal(targetFromPath('/nope'), null);
});

test('rewriteRef resolves relatives and leaves opaque schemes alone', () => {
  const base = 'https://example.com/dir/page.html';
  assert.equal(rewriteRef('../x', base), '/p/https://example.com/x');
  assert.equal(rewriteRef('/y', base), '/p/https://example.com/y');
  assert.equal(rewriteRef('//cdn.test/z', base), '/p/https://cdn.test/z');
  assert.equal(rewriteRef('https://other.test/', base), '/p/https://other.test/');
  for (const opaque of ['#frag', 'mailto:a@b.c', 'javascript:void 0', 'data:text/plain,x', 'about:blank', '']) {
    assert.equal(rewriteRef(opaque, base), null, `${opaque} must be left alone`);
  }
  assert.equal(rewriteRef('/p/https://example.com/a', base), null, 'already proxied');
});

test('rewriteSrcset keeps descriptors', () => {
  assert.equal(
    rewriteSrcset('a.png 1x, /b.png 2x', 'https://e.test/d/'),
    '/p/https://e.test/d/a.png 1x, /p/https://e.test/b.png 2x'
  );
});

test('rewriteCss handles url() and @import', () => {
  const out = rewriteCss('@import "/m.css";\n.a{background:url(img/x.png)}', 'https://e.test/d/');
  assert.match(out, /@import "\/p\/https:\/\/e\.test\/m\.css"/);
  assert.match(out, /url\(\/p\/https:\/\/e\.test\/d\/img\/x\.png\)/);
  assert.match(rewriteCss('a{background:url(data:image/png;base64,AA)}', 'https://e.test/'), /data:image/);
});

test('rewriteHtml rewrites references and injects the hook', () => {
  const html = `<html><head><title>t</title></head><body>
    <a href="about.html">a</a>
    <a href="mailto:x@y.z">m</a>
    <img src="/i.png" srcset="/a.png 1x">
    <script src="/s.js" integrity="sha384-zz"></script>
    <form action="/post"></form>
    <div style="background:url(/bg.png)"></div>
  </body></html>`;
  const out = rewriteHtml(html, 'https://e.test/dir/page.html');

  assert.match(out, /href="\/p\/https:\/\/e\.test\/dir\/about\.html"/);
  assert.match(out, /href="mailto:x@y\.z"/, 'mailto untouched');
  assert.match(out, /src="\/p\/https:\/\/e\.test\/i\.png"/);
  assert.match(out, /srcset="\/p\/https:\/\/e\.test\/a\.png 1x"/);
  assert.match(out, /action="\/p\/https:\/\/e\.test\/post"/);
  assert.match(out, /url\(\/p\/https:\/\/e\.test\/bg\.png\)/);
  assert.doesNotMatch(out, /integrity=/, 'integrity must be dropped');
  assert.match(out, /src="\/__px\/hook\.js"/);
  assert.match(out, /window\.__PX__=/);
  assert.ok(out.indexOf('__PX__') < out.indexOf('<title>'), 'hook must run before page scripts');
});

test('rewriteHtml honours <base href> then neutralises it', () => {
  const out = rewriteHtml('<html><head><base href="https://cdn.test/x/"></head><body><a href="y.html">y</a></body></html>', 'https://e.test/page');
  assert.match(out, /href="\/p\/https:\/\/cdn\.test\/x\/y\.html"/);
  assert.doesNotMatch(out, /<base href=/);
});

test('rewriteHtml strips CSP meta and rewrites meta refresh', () => {
  const out = rewriteHtml(
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
      '<meta http-equiv="refresh" content="3; url=/next"></head><body></body></html>',
    'https://e.test/'
  );
  assert.doesNotMatch(out, /Content-Security-Policy/i);
  assert.match(out, /content="3; url=\/p\/https:\/\/e\.test\/next"/);
});

test('rewriteHtml survives malformed markup', () => {
  assert.ok(rewriteHtml('<p>unclosed <a href="/x">link', 'https://e.test/').includes('/p/https://e.test/x'));
});

test('rewriteLocation proxies redirect targets', () => {
  assert.equal(rewriteLocation('/next', 'https://e.test/a/b'), '/p/https://e.test/next');
  assert.equal(rewriteLocation('https://other.test/', 'https://e.test/'), '/p/https://other.test/');
});

test('toProxy round-trips through targetFromPath', () => {
  const url = 'https://e.test/a/b?c=d&e=f#g';
  assert.equal(targetFromPath(toProxy(url)).href, url);
});

test('isPrivateAddress covers the ranges that matter', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('assertPublicHost rejects local names and addresses', async () => {
  delete process.env.PROXY_ALLOW_PRIVATE;
  for (const host of ['localhost', '127.0.0.1', '169.254.169.254', 'foo.internal', '[::1]']) {
    await assert.rejects(() => assertPublicHost(host), undefined, `${host} should be blocked`);
  }
});

test('assertPublicHost can be opted out of', async () => {
  process.env.PROXY_ALLOW_PRIVATE = '1';
  await assert.doesNotReject(() => assertPublicHost('127.0.0.1'));
  delete process.env.PROXY_ALLOW_PRIVATE;
});

test('cookie jar matches on domain, path, expiry and secure', () => {
  const sid = 'session-under-test';
  clearJar(sid);
  const url = new URL('https://shop.test/cart/view');

  storeCookies(sid, url, [
    'sid=abc; Path=/',
    'cart=1; Path=/cart',
    'other=2; Path=/admin',
    'wide=3; Domain=shop.test; Path=/',
    'gone=4; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'onlyhttps=5; Path=/; Secure',
  ]);

  const header = cookieHeader(sid, url);
  assert.match(header, /sid=abc/);
  assert.match(header, /cart=1/);
  assert.match(header, /wide=3/);
  assert.match(header, /onlyhttps=5/);
  assert.doesNotMatch(header, /other=2/, 'path must not match /admin');
  assert.doesNotMatch(header, /gone=4/, 'expired cookie must be dropped');

  assert.doesNotMatch(cookieHeader(sid, new URL('http://shop.test/cart/view')), /onlyhttps/, 'Secure needs https');
  assert.equal(cookieHeader(sid, new URL('https://elsewhere.test/')), '', 'no cross-site leakage');
  assert.match(cookieHeader(sid, new URL('https://sub.shop.test/')), /wide=3/, 'Domain cookie covers subdomains');
  assert.doesNotMatch(cookieHeader(sid, new URL('https://sub.shop.test/')), /sid=abc/, 'host-only stays host-only');

  assert.equal(cookieHeader('a-different-session', url), '', 'jars are per session');
  clearJar(sid);
  assert.equal(cookieHeader(sid, url), '', 'clearJar wipes it');
});
