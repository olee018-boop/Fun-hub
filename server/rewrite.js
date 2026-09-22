// Rewrites documents so every reference points back through the proxy.

import * as cheerio from 'cheerio';
import { rewriteRef, rewriteSrcset, toProxy } from './url.js';

// attribute -> selector of elements that carry a URL in it
const URL_ATTRS = [
  ['href', 'a, area, link, base'],
  ['src', 'img, script, iframe, frame, embed, source, track, audio, video, input'],
  ['action', 'form'],
  ['formaction', 'button, input'],
  ['poster', 'video'],
  ['data', 'object'],
  ['background', 'body, table, td, th'],
  ['cite', 'blockquote, q, del, ins'],
];

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

/** Rewrite url(...) and @import references inside a stylesheet. */
export function rewriteCss(css, base) {
  return String(css)
    .replace(CSS_URL, (match, quote, url) => {
      const proxied = rewriteRef(url, base);
      return proxied ? `url(${quote}${proxied}${quote})` : match;
    })
    .replace(CSS_IMPORT, (match, quote, url) => {
      const proxied = rewriteRef(url, base);
      return proxied ? `@import ${quote}${proxied}${quote}` : match;
    });
}

/**
 * Rewrite an HTML document.
 * @param {string} html raw markup
 * @param {string} base the absolute URL the document was loaded from
 */
export function rewriteHtml(html, base) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // A <base href> changes how every other reference resolves, so consume it
  // first and then neutralise it (the proxied URLs are already absolute).
  let effectiveBase = base;
  const baseEl = $('base[href]').first();
  if (baseEl.length) {
    try {
      effectiveBase = new URL(baseEl.attr('href'), base).href;
    } catch {
      /* keep the document URL */
    }
    baseEl.removeAttr('href');
  }

  for (const [attr, selector] of URL_ATTRS) {
    $(`${selector}`).each((_i, el) => {
      const $el = $(el);
      const value = $el.attr(attr);
      if (value == null) return;
      const proxied = rewriteRef(value, effectiveBase);
      if (proxied) {
        $el.attr(`data-px-${attr}`, value);
        $el.attr(attr, proxied);
      }
    });
  }

  $('[srcset], [imagesrcset]').each((_i, el) => {
    const $el = $(el);
    for (const attr of ['srcset', 'imagesrcset']) {
      const value = $el.attr(attr);
      if (value) $el.attr(attr, rewriteSrcset(value, effectiveBase));
    }
  });

  // Inline styles and <style> blocks.
  $('[style]').each((_i, el) => {
    const $el = $(el);
    $el.attr('style', rewriteCss($el.attr('style'), effectiveBase));
  });
  $('style').each((_i, el) => {
    const $el = $(el);
    $el.text(rewriteCss($el.text(), effectiveBase));
  });

  // Subresource integrity can't survive rewriting, and CSP/refresh headers in
  // <meta> would undo the work we just did.
  $('[integrity]').removeAttr('integrity');
  $('meta[http-equiv]').each((_i, el) => {
    const $el = $(el);
    const equiv = String($el.attr('http-equiv')).toLowerCase();
    if (equiv === 'content-security-policy') {
      $el.remove();
    } else if (equiv === 'refresh') {
      const content = String($el.attr('content') || '');
      const m = content.match(/^(\s*[\d.]+\s*;\s*url\s*=\s*)(.+)$/i);
      if (m) {
        const proxied = rewriteRef(m[2].replace(/^['"]|['"]$/g, ''), effectiveBase);
        if (proxied) $el.attr('content', m[1] + proxied);
      }
    }
  });

  // Anything the static pass can't see (scripts, innerHTML, fetch) is handled
  // at runtime by the hook, which must run before any of the page's own code.
  const bootstrap = `<script data-px-hook>window.__PX__=${JSON.stringify({
    base: effectiveBase,
    documentUrl: base,
  })};</script><script data-px-hook src="/__px/hook.js"></script>`;

  const head = $('head').first();
  if (head.length) head.prepend(bootstrap);
  else if ($('html').length) $('html').prepend(`<head>${bootstrap}</head>`);
  else $.root().prepend(bootstrap);

  return $.html();
}

/** Rewrite a Location header so redirects stay inside the proxy. */
export function rewriteLocation(location, base) {
  try {
    return toProxy(new URL(location, base).href);
  } catch {
    return location;
  }
}
