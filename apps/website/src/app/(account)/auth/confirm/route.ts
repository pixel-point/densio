import { completeLogin } from "@/lib/densio/confirm-login";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

export function HEAD() {
  return new Response(null, { status: 204, headers: privateHeaders });
}

export async function GET(request: Request) {
  const speculative =
    request.headers.has("next-router-prefetch") ||
    ["purpose", "sec-purpose"].some((name) => request.headers.get(name)?.includes("prefetch"));
  if (speculative) return HEAD();
  const tokens = new URL(request.url).searchParams.getAll("token");
  const token = tokens.length === 1 ? tokens[0] : undefined;
  const destination =
    token && token.length <= 256 ? await completeLogin(token) : "/auth/result?status=invalid";
  // Relative redirects keep the browser's public origin behind reverse proxies.
  return new Response(null, {
    status: 303,
    headers: { ...privateHeaders, Location: destination },
  });
}
