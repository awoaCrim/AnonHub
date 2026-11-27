import { isIPv4 } from "node:net";

/** One IPv4 network a host-local connection may arrive on, e.g. the Docker bridges' 172.16.0.0/12. */
export interface LocalNetwork {
  base: number;
  mask: number;
}

/** `172.16.0.0/12,192.168.241.0/28`: private IPv4 networks only, so the home LAN or the internet never qualify by accident. */
export function parseLocalNetworks(text: string): LocalNetwork[] {
  const networks = text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry);
      if (!match || !isIPv4(match[1]!)) throw new Error("invalid_local_network");
      const bits = Number(match[2]);
      if (bits < 8 || bits > 32) throw new Error("invalid_local_network");
      const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
      const base = (toNumber(match[1]!) & mask) >>> 0;
      // Wholly inside 10/8, 172.16/12 or 192.168/16.
      const within = (prefix: number, network: number) => bits >= prefix && (base & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0 === network;
      if (!(within(8, 0x0a000000) || within(12, 0xac100000) || within(16, 0xc0a80000))) throw new Error("local_network_not_private");
      return { base, mask };
    });
  if (!networks.length || networks.length > 16) throw new Error("invalid_local_network");
  return networks;
}

/**
 * Whether a connection arrived on one of the host's own addresses inside these networks. The listener
 * binds every interface; this keeps it to the host bridges (a LAN address is refused before any byte is read).
 */
export function localAddressAllowed(address: string | undefined, networks: readonly LocalNetwork[]): boolean {
  if (!address) return false;
  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (!isIPv4(plain)) return false;
  const value = toNumber(plain);
  return networks.some((network) => (value & network.mask) >>> 0 === network.base);
}

const toNumber = (address: string) => address.split(".").reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
