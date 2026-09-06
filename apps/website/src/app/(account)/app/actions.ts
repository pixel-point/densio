"use server";
import {
  OrganizationSchema,
  OrganizationCreateResponseSchema,
  OrganizationMembershipSchema,
  DefaultOrganizationRequestSchema,
} from "@densio/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { densioApi } from "@/lib/densio/api";
import { authenticatedRequest, organizationApiPath } from "@/lib/densio/mutations";
import { cookieNames, readCookie, writeCookie } from "@/lib/densio/cookies";
import { accountPath, switchOrganizationPath } from "@/lib/densio/navigation";
import type { FormState } from "@/lib/densio/form-state";

export async function renameOrganization(
  organizationId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const result = await authenticatedRequest(
    organizationApiPath(organizationId),
    OrganizationSchema,
    { method: "PATCH", body: { name: String(form.get("name") ?? "").trim() } },
    accountPath(organizationId),
  );
  if (!result.ok) return { error: result.error.detail };
  revalidatePath(`/app/${encodeURIComponent(organizationId)}`, "layout");
  return { success: "Organization name updated." };
}
export async function createOrganization(_state: FormState, form: FormData): Promise<FormState> {
  const result = await authenticatedRequest("/v1/organizations", OrganizationCreateResponseSchema, {
    method: "POST",
    body: { name: String(form.get("name") ?? "").trim() },
    idempotencyKey: String(form.get("idempotencyKey") ?? ""),
  });
  if (!result.ok) return { error: result.error.detail };
  await rememberOrganization(result.data.organization.organizationId);
  revalidatePath("/app", "layout");
  redirect(accountPath(result.data.organization.organizationId));
}
export async function selectOrganization(
  organizationId: string,
  pathname: string,
): Promise<FormState> {
  const token = await readCookie(cookieNames.session);
  if (!token) redirect("/auth/login");
  const result = await densioApi()(
    organizationApiPath(organizationId),
    OrganizationMembershipSchema,
    { token },
  );
  if (!result.ok) return { error: result.error.detail };
  if (result.data.organization.state !== "active")
    return { error: "This organization is no longer active." };
  await rememberOrganization(organizationId);
  redirect(switchOrganizationPath(pathname, organizationId));
}
export async function setDefaultOrganization(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = String(form.get("organizationId") ?? "");
  const result = await authenticatedRequest(
    "/v1/auth/default-organization",
    DefaultOrganizationRequestSchema,
    { method: "PUT", body: { organizationId } },
  );
  if (!result.ok) return { error: result.error.detail };
  revalidatePath("/app", "layout");
  return { success: "Default organization updated for your account and CLI." };
}
async function rememberOrganization(organizationId: string) {
  await writeCookie(
    cookieNames.organization,
    organizationId,
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  );
}
