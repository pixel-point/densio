import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export const makeRequestIpHasher =
  (secret: string, trustProxy: boolean) =>
  (request: Request, remoteAddress: string | undefined) => {
    const forwardedAddress = trustProxy
      ? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
      : undefined;
    const address =
      validIp(forwardedAddress) ?? validIp(normalizeRemote(remoteAddress)) ?? "unknown";
    return createHmac("sha256", secret).update(address).digest("hex");
  };

const validIp = (value: string | undefined) =>
  value !== undefined && isIP(value) !== 0 ? value : undefined;

const normalizeRemote = (value: string | undefined) =>
  value?.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
