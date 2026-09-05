import type { ReactNode } from "react";
import { Body, Container, Head, Heading, Html, Preview, Section, Text } from "react-email";
import { emailStyles, emailTheme } from "../theme.ts";
import { EmailDivider } from "./email-divider.tsx";

interface EmailLayoutProps {
  readonly preview: string;
  readonly heading: string;
  readonly notice?: string;
  readonly children: ReactNode;
}

export const EmailLayout = ({ preview, heading, notice, children }: EmailLayoutProps) => (
  <Html lang="en">
    <Head>
      <meta name="color-scheme" content="light" />
      <style>{`
        @media (max-width: 600px) {
          .email-container > tbody > tr > td { padding-top: 24px !important; }
          .email-content > tbody > tr > td, .email-footer > tbody > tr > td { padding-left: 24px !important; padding-right: 24px !important; }
        }
      `}</style>
    </Head>
    <Preview>{preview}</Preview>
    <Body
      style={{
        backgroundColor: emailTheme.colors.canvas,
        fontFamily: emailTheme.fontFamily,
        margin: 0,
        padding: 0,
      }}
    >
      <Container
        className="email-container"
        style={{ maxWidth: "640px", margin: "0 auto", padding: "64px 16px 24px" }}
      >
        <Section style={{ backgroundColor: emailTheme.colors.background }}>
          <Section className="email-content" style={{ padding: "64px 40px 0" }}>
            <Text
              style={{
                color: emailTheme.colors.foreground,
                fontSize: "32px",
                fontWeight: 700,
                letterSpacing: "-1.6px",
                lineHeight: "40px",
                margin: "0 0 48px",
              }}
            >
              densio
            </Text>
            <Heading
              as="h1"
              style={{
                color: emailTheme.colors.foreground,
                fontFamily: emailTheme.fontFamily,
                fontSize: "30px",
                fontWeight: 600,
                lineHeight: "normal",
                letterSpacing: "normal",
                margin: "24px 0 0",
                padding: 0,
              }}
            >
              {heading}
            </Heading>
            {children}
            {notice === undefined ? null : <Text style={emailStyles.paragraph}>{notice}</Text>}
          </Section>
          <Section className="email-footer" style={{ padding: "0 40px 48px" }}>
            <EmailDivider />
            <Text style={emailStyles.small}>Prime UI, Inc.</Text>
            <Text style={emailStyles.small}>
              131 Continental Dr, Suite 305, Newark, DE 19713, USA
            </Text>
          </Section>
        </Section>
      </Container>
    </Body>
  </Html>
);
