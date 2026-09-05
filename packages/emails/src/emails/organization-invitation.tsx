import { Link, Text } from "react-email";
import { ActionButton } from "../components/action-button.tsx";
import { EmailDivider } from "../components/email-divider.tsx";
import { EmailLayout } from "../components/email-layout.tsx";
import { emailStyles } from "../theme.ts";

export interface OrganizationInvitationEmailProps {
  readonly name: string;
  readonly acceptanceUrl: string;
}

export const OrganizationInvitationEmail = ({
  name,
  acceptanceUrl,
}: OrganizationInvitationEmailProps) => (
  <EmailLayout preview={`You have been invited to ${name} on Densio`} heading="You're invited">
    <Text style={{ ...emailStyles.paragraph, marginTop: "12px" }}>
      You have been invited to join {name} on Densio. Click the button below to accept your
      invitation.
    </Text>
    <ActionButton href={acceptanceUrl} variant="solid">
      Accept invitation
    </ActionButton>
    <EmailDivider />
    <Text style={{ ...emailStyles.paragraph, margin: 0 }}>
      If the button above does not work, please copy and paste the following URL into your browser:
    </Text>
    <Text
      style={{
        ...emailStyles.link,
        margin: "8px 0 0",
        wordBreak: "break-all",
      }}
    >
      <Link href={acceptanceUrl} style={{ ...emailStyles.link, color: "#2D69EC" }}>
        {acceptanceUrl}
      </Link>
    </Text>
  </EmailLayout>
);

OrganizationInvitationEmail.PreviewProps = {
  name: "Example Studio",
  acceptanceUrl: "https://example.com/v1/organization-invitations/confirm?token=preview-only",
} satisfies OrganizationInvitationEmailProps;

export default OrganizationInvitationEmail;
