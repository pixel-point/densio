import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import {
  type OrganizationListResponse,
  AuthStatusSchema,
  OrganizationListResponseSchema,
  OrganizationMembershipSchema,
} from "@densio/shared";
import type { ApiResult } from "./client";
import { densioApi } from "./api";
import { cookieNames, readCookie } from "./cookies";
import { accountPath, safeReturnTo } from "./navigation";

export const getSession = cache(async () => {
  const token = await readCookie(cookieNames.session);
  if (!token) return null;
  const result = await densioApi()("/v1/auth/status", AuthStatusSchema, { token });
  if (!result.ok) {
    if (result.error.status === 401) return null;
    return { ok: false as const, error: result.error };
  }
  if (!result.data.authenticated) return null;
  return { ok: true as const, token, ...result.data };
});

export const requireSession = async (returnTo = "/app") => {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
  return session;
};

export const getOrganizations = cache(async (token: string) => {
  const request = densioApi();
  const first = await request(
    "/v1/organizations?limit=100&state=active",
    OrganizationListResponseSchema,
    { token },
  );
  if (!first.ok) return first;
  const loadRemaining = async (cursor: string): Promise<ApiResult<OrganizationListResponse>> => {
    const next = await request(
      `/v1/organizations?limit=100&state=active&cursor=${encodeURIComponent(cursor)}`,
      OrganizationListResponseSchema,
      { token },
    );
    if (!next.ok || !next.data.nextCursor) return next;
    const remaining = await loadRemaining(next.data.nextCursor);
    if (!remaining.ok) return remaining;
    return {
      ok: true,
      data: { organizations: [...next.data.organizations, ...remaining.data.organizations] },
    };
  };
  if (!first.data.nextCursor) return first;
  const remaining = await loadRemaining(first.data.nextCursor);
  if (!remaining.ok) return remaining;
  return {
    ok: true as const,
    data: { organizations: [...first.data.organizations, ...remaining.data.organizations] },
  };
});

export const getAccount = cache(async (organizationId: string, section = "") => {
  const session = await requireSession(accountPath(organizationId, section));
  if (!session.ok) return session;
  const membership = await densioApi()(
    `/v1/organizations/${encodeURIComponent(organizationId)}`,
    OrganizationMembershipSchema,
    { token: session.token },
  );
  if (!membership.ok) return membership;
  if (membership.data.organization.state !== "active")
    return {
      ok: false as const,
      error: {
        code: "ORGANIZATION_NOT_ACTIVE",
        status: 409,
        title: "Organization unavailable",
        detail:
          "This organization is being closed or has been deleted. Select another organization from your account.",
        retryable: false,
      },
    };
  return { ok: true as const, ...membership.data, session };
});
