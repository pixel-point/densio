"use server";

import {
  AuthStartResponseSchema,
  AuthStatusSchema,
  BrowserAuthPollResponseSchema,
  LogoutResponseSchema,
} from "@densio/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { densioApi } from "@/lib/densio/api";
import { cookieNames, readCookie, writeCookie, clearLoginCookies } from "@/lib/densio/cookies";
import { safeReturnTo } from "@/lib/densio/navigation";
import type { AuthFormState, FormState, PollState } from "@/lib/densio/form-state";

export async function beginLogin(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const email = String(form.get("email") ?? "").trim();
  const result = await densioApi()("/v1/auth/login", AuthStartResponseSchema, {
    method: "POST",
    body: { email },
  });
  if (!result.ok) return { error: result.error.detail };
  const expires = new Date(result.data.expiresAt);
  await writeCookie(cookieNames.challenge, result.data.challengeId, expires);
  await writeCookie(cookieNames.poll, result.data.pollToken, expires);
  await writeCookie(
    cookieNames.returnTo,
    safeReturnTo(String(form.get("returnTo") ?? "")),
    expires,
  );
  return {
    waiting: {
      email,
      expiresAt: result.data.expiresAt,
      pollAfterSeconds: result.data.pollAfterSeconds,
    },
  };
}

export async function pollLogin(fallbackReturnTo = "/app"): Promise<PollState> {
  const returnTo = safeReturnTo((await readCookie(cookieNames.returnTo)) ?? fallbackReturnTo);
  const pollToken = await readCookie(cookieNames.poll);
  if (!pollToken)
    return (
      (await completedBrowserLogin(returnTo)) ?? {
        status: "error",
        error: "This sign-in request has expired. Request a new link to continue.",
      }
    );
  const result = await densioApi()("/v1/auth/browser/poll", BrowserAuthPollResponseSchema, {
    method: "POST",
    body: { pollToken },
  });
  if (!result.ok) {
    // Another tab can redeem the challenge before its Set-Cookie response reaches this one.
    if (result.error.code === "AUTH_CHALLENGE_USED")
      return (await completedBrowserLogin(returnTo)) ?? { status: "pending", pollAfterSeconds: 1 };
    return { status: "error", error: result.error.detail };
  }
  if (result.data.status === "pending") return result.data;
  await writeCookie(cookieNames.session, result.data.sessionToken, new Date(result.data.expiresAt));
  await clearLoginCookies();
  return { status: "confirmed", returnTo };
}

async function completedBrowserLogin(returnTo: string): Promise<PollState | null> {
  const token = await readCookie(cookieNames.session);
  if (!token) return null;
  const session = await densioApi()("/v1/auth/status", AuthStatusSchema, { token });
  return session.ok && session.data.authenticated ? { status: "confirmed", returnTo } : null;
}

export async function logout(_previous: FormState, _form: FormData): Promise<FormState> {
  const token = await readCookie(cookieNames.session);
  if (token) {
    const result = await densioApi()("/v1/auth/logout", LogoutResponseSchema, {
      method: "POST",
      token,
    });
    if (!result.ok && result.error.status !== 401) return { error: result.error.detail };
  }
  const store = await cookies();
  store.delete(cookieNames.session);
  store.delete(cookieNames.organization);
  await clearLoginCookies();
  redirect("/auth/login");
}
