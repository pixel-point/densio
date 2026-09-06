"use server";
import { OrganizationInvitationSchema } from "@densio/shared";
import { revalidatePath } from "next/cache";
import { authenticatedRequest, organizationApiPath } from "@/lib/densio/mutations";
import { accountPath } from "@/lib/densio/navigation";
import type { FormState } from "@/lib/densio/form-state";

export async function inviteMember(
  organizationId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  const result = await authenticatedRequest(
    organizationApiPath(organizationId, "/invitations"),
    OrganizationInvitationSchema,
    {
      method: "POST",
      body: {
        email: String(form.get("email") ?? "").trim(),
        role: String(form.get("role") ?? "member"),
      },
    },
    accountPath(organizationId, "members"),
  );
  if (!result.ok) return { error: result.error.detail };
  revalidatePath(accountPath(organizationId, "members"));
  return { success: `Invitation sent to ${result.data.email}.` };
}
export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
  _state: FormState,
  _form: FormData,
): Promise<FormState> {
  const result = await authenticatedRequest(
    organizationApiPath(organizationId, `/invitations/${encodeURIComponent(invitationId)}`),
    OrganizationInvitationSchema,
    { method: "DELETE" },
    accountPath(organizationId, "members"),
  );
  if (!result.ok) return { error: result.error.detail };
  revalidatePath(accountPath(organizationId, "members"));
  return { success: "Invitation revoked." };
}
