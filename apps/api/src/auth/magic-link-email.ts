export interface MagicLinkEmailInput {
  readonly expiresInMinutes: number;
  readonly verificationUrl: string;
}

export interface MagicLinkEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

export const renderMagicLinkEmail = ({
  expiresInMinutes,
  verificationUrl,
}: MagicLinkEmailInput): MagicLinkEmail => ({
  subject: "Confirm your ffmpeg-api CLI login",
  text: [
    "Confirm your ffmpeg-api CLI login by opening this link:",
    verificationUrl,
    `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
  ].join("\n\n"),
  html: [
    "<p>Confirm your ffmpeg-api CLI login.</p>",
    `<p><a href="${escapeHtml(verificationUrl)}">Confirm CLI login</a></p>`,
    `<p>This link expires in ${expiresInMinutes} minutes and can only be used once.</p>`,
  ].join(""),
});
