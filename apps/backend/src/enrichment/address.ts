import { BlockList, isIP } from 'node:net';

/** Address ranges a diagnostic must never connect to (local, private, shared, reserved or multicast). */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** IPv4 address embedded in an IPv4-mapped IPv6 address (::ffff:a.b.c.d in any spelling). */
function mappedIpv4(address: string): string | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname;
  } catch {
    return null;
  }
  const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);
  if (!match) return null;
  const high = parseInt(match[1]!, 16);
  const low = parseInt(match[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True only for a syntactically valid IP address outside every non-public range. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4');
  if (family !== 6) return false;
  const v4 = mappedIpv4(address);
  if (v4) return isPublicAddress(v4);
  return !NON_PUBLIC.check(address, 'ipv6');
}

/** LDH hostname with at least two labels and a non-numeric TLD (rejects IP literals). */
export function isValidHostname(name: string): boolean {
  if (name.length < 3 || name.length > 253 || isIP(name) !== 0) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
