import "server-only";
import type { Schema } from "effect";
import { redirect } from "next/navigation";
import { densioApi } from "./api";
import { cookieNames, readCookie } from "./cookies";

export async function authenticatedRequest<
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  path: string,
  schema: S,
  options: { method: "POST" | "PATCH" | "DELETE" | "PUT"; body?: unknown; idempotencyKey?: string },
  returnTo = "/app",
) {
  const token = await readCookie(cookieNames.session);
  if (!token) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  const result = await densioApi()(path, schema, { ...options, token });
  if (!result.ok && result.error.status === 401)
    redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  return result;
}
export const organizationApiPath = (organizationId: string, suffix = "") =>
  `/v1/organizations/${encodeURIComponent(organizationId)}${suffix}`;
