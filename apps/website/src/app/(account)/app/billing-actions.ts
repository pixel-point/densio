"use server";
import { BillingContactResponseSchema, BillingSessionResponseSchema } from "@densio/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authenticatedRequest, organizationApiPath } from "@/lib/densio/mutations";
import { accountPath } from "@/lib/densio/navigation";
import type { FormState } from "@/lib/densio/form-state";

export async function updateBillingContact(
  organizationId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const result = await authenticatedRequest(
    organizationApiPath(organizationId, "/billing/contact"),
    BillingContactResponseSchema,
    { method: "PATCH", body: { billingEmail: String(form.get("billingEmail") ?? "").trim() } },
    accountPath(organizationId, "billing"),
  );
  if (!result.ok) return { error: result.error.detail };
  revalidatePath(accountPath(organizationId, "billing"));
  return { success: "Billing contact updated." };
}
export async function openBillingPortal(
  organizationId: string,
  _state: FormState,
  _form: FormData,
): Promise<FormState> {
  const result = await authenticatedRequest(
    organizationApiPath(organizationId, "/billing/portal"),
    BillingSessionResponseSchema,
    { method: "POST" },
    accountPath(organizationId, "billing"),
  );
  if (!result.ok) return { error: result.error.detail };
  redirect(result.data.url);
}
export async function checkoutPlan(
  organizationId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const result = await authenticatedRequest(
    organizationApiPath(organizationId, "/billing/checkout"),
    BillingSessionResponseSchema,
    {
      method: "POST",
      body: { plan: String(form.get("plan") ?? "") },
      idempotencyKey: String(form.get("idempotencyKey") ?? ""),
    },
    accountPath(organizationId, "billing"),
  );
  if (!result.ok) return { error: result.error.detail };
  redirect(result.data.url);
}
