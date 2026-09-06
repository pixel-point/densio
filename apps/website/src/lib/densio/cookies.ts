import "server-only";
import { cookies, headers } from "next/headers";

export const cookieNames = {
  session: "densio_session",
  challenge: "densio_login_challenge",
  poll: "densio_login_poll",
  returnTo: "densio_login_return",
  organization: "densio_organization",
} as const;

export const readCookie = async (name: string) => (await cookies()).get(name)?.value;

export const writeCookie = async (name: string, value: string, expires: Date) => {
  const requestHeaders = await headers();
  const https = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  (await cookies()).set(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || https,
    sameSite: "lax",
    path: "/",
    expires,
  });
};

export const clearLoginCookies = async () => {
  const store = await cookies();
  [cookieNames.challenge, cookieNames.poll, cookieNames.returnTo].forEach((name) =>
    store.delete(name),
  );
};
