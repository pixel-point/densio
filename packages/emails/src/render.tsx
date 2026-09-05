import type { ReactElement } from "react";
import { render, toPlainText } from "react-email";
import {
  SignInConfirmationEmail,
  type SignInConfirmationEmailProps,
} from "./emails/sign-in-confirmation.tsx";
import {
  OrganizationInvitationEmail,
  type OrganizationInvitationEmailProps,
} from "./emails/organization-invitation.tsx";
import {
  StorageRetentionEmail,
  type StorageRetentionEmailProps,
} from "./emails/storage-retention.tsx";

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export const renderSignInConfirmationEmail = (input: SignInConfirmationEmailProps) =>
  renderEmail("Confirm your sign-in to Densio", <SignInConfirmationEmail {...input} />);

export const renderOrganizationInvitationEmail = (input: OrganizationInvitationEmailProps) =>
  renderEmail("Invitation to a Densio organization", <OrganizationInvitationEmail {...input} />);

export const renderStorageRetentionEmail = (input: StorageRetentionEmailProps) =>
  renderEmail(
    "Action required: your Densio storage is over its limit",
    <StorageRetentionEmail {...input} />,
  );

const renderEmail = async (subject: string, element: ReactElement): Promise<EmailContent> => {
  const html = await render(element);
  return { subject, html, text: toPlainText(html) };
};
