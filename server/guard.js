// Keeps the proxy from being pointed at the machine it runs on.
//
// Without this, anyone who can reach the UI could browse to
// http://localhost:8080 or http://169.254.169.254 and read the Codespace's own
// services and cloud metadata. Set PROXY_ALLOW_PRIVATE=1 to opt out when you
// deliberately want to proxy something on the local network.

import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(ip) {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('::ffff:')) return isPrivateIPv4(addr.slice(7));
  return false;
}

export function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return false;
}

/** Throws if the hostname resolves somewhere we refuse to proxy. */
export async function assertPublicHost(hostname) {
  if (process.env.PROXY_ALLOW_PRIVATE === '1') return;
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('this host is on the local network.');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('this address is on the local network.');
    return;
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve "${hostname}".`);
  }
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new Error('this host resolves to a local network address.');
  }
}
