"use server";
import { OrganizationInvitationLinkResponseSchema } from "@densio/shared";
import { densioApi } from "@/lib/densio/api";
import type { FormState } from "@/lib/densio/form-state";

export async function acceptInvitation(
  token: string,
  _state: FormState,
  _form: FormData,
): Promise<FormState> {
  const result = await densioApi()(
    "/v1/organization-invitations/link",
    OrganizationInvitationLinkResponseSchema,
    { method: "POST", body: { token } },
  );
  if (!result.ok) return { error: result.error.detail };
  return { success: `You joined ${result.data.name}.` };
}
