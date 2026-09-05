import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { isValid, parse } from "ipaddr.js";

export const isPublicAddress = (address: string) =>
  isValid(address) && parse(address).range() === "unicast";

export const assertStorageEndpoint = (
  value: string,
  allowPath = false,
  allowedOrigins: readonly string[] = [],
) => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPath && url.pathname !== "/")
  )
    throw new Error("Storage endpoint must not contain credentials, queries or unsupported paths.");
  if (allowedOrigins.includes(url.origin)) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) !== 0 && !isPublicAddress(host))
  )
    throw new Error("Storage endpoints must use public HTTPS on port 443.");
  return url;
};

export const resolveStorageAddress = async (
  hostname: string,
  resolve: (host: string) => Promise<readonly { address: string; family: number }[]> = (host) =>
    lookup(host, { all: true, verbatim: true }),
) => {
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new Error("Storage DNS resolved to a prohibited address.");
  const address = addresses[0];
  if (address === undefined) throw new Error("Storage DNS returned no address.");
  return address;
};

export const storageLookup: LookupFunction = (hostname, options, callback) => {
  void resolveStorageAddress(hostname).then(
    (address) => callback(null, options.all ? [address] : address.address, address.family),
    () => callback(new Error("Storage address rejected."), "", 4),
  );
};
