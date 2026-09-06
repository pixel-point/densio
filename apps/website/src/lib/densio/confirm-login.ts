import "server-only";
import { AuthConfirmResponseSchema, BrowserAuthConfirmResponseSchema } from "@densio/shared";
import { densioApi } from "./api";
import { clearLoginCookies, cookieNames, readCookie, writeCookie } from "./cookies";
import { safeReturnTo } from "./navigation";

export async function completeLogin(token: string): Promise<string> {
  const [challenge, pollToken, savedReturnTo] = await Promise.all([
    readCookie(cookieNames.challenge),
    readCookie(cookieNames.poll),
    readCookie(cookieNames.returnTo),
  ]);
  // A CLI or another browser keeps ownership of its own polling secret.
  if (token.split(".")[0] !== challenge || !pollToken) {
    const result = await densioApi()("/v1/auth/confirm", AuthConfirmResponseSchema, {
      method: "POST",
      body: { token },
    });
    return result.ok ? "/auth/result?status=confirmed" : failurePath(result.error.code);
  }

  const result = await densioApi()("/v1/auth/browser/confirm", BrowserAuthConfirmResponseSchema, {
    method: "POST",
    body: { token, pollToken },
  });
  if (!result.ok) return failurePath(result.error.code);
  await writeCookie(cookieNames.session, result.data.sessionToken, new Date(result.data.expiresAt));
  await clearLoginCookies();
  return safeReturnTo(savedReturnTo);
}

function failurePath(code: string) {
  const status =
    code === "AUTH_CHALLENGE_EXPIRED"
      ? "expired"
      : code === "AUTH_CHALLENGE_USED"
        ? "used"
        : code === "AUTH_CHALLENGE_INVALID" || code === "INVALID_REQUEST"
          ? "invalid"
          : "unavailable";
  return `/auth/result?status=${status}`;
}
