import { Link, Text } from "react-email";
import { ActionButton } from "../components/action-button.tsx";
import { EmailDivider } from "../components/email-divider.tsx";
import { EmailLayout } from "../components/email-layout.tsx";
import { emailStyles } from "../theme.ts";

export interface SignInConfirmationEmailProps {
  readonly verificationUrl: string;
}

export const SignInConfirmationEmail = ({ verificationUrl }: SignInConfirmationEmailProps) => (
  <EmailLayout preview="Access your account" heading="Access your account">
    <Text style={{ ...emailStyles.paragraph, marginTop: "12px" }}>
      To continue, please click the button below. This link provides secure access to your Densio
      account.
    </Text>
    <ActionButton href={verificationUrl} variant="solid">
      Continue
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
      <Link href={verificationUrl} style={{ ...emailStyles.link, color: "#2D69EC" }}>
        {verificationUrl}
      </Link>
    </Text>
  </EmailLayout>
);

SignInConfirmationEmail.PreviewProps = {
  verificationUrl: "https://example.com/auth/confirm?token=preview-only",
} satisfies SignInConfirmationEmailProps;

export default SignInConfirmationEmail;
