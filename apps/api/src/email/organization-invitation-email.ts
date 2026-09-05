export const renderOrganizationInvitationEmail = (input: {
  name: string;
  invitationId: string;
  expiresAt: number;
}) => {
  const instructions = `You have been invited to ${input.name}.\n\nSign in using the invited email:\nnpx densio auth login YOUR_INVITED_EMAIL\n\nThen accept explicitly:\nnpx densio --json invitations accept ${input.invitationId}\n\nExpires ${new Date(input.expiresAt).toISOString()}. Joining does not change your default organization.`;
  return {
    subject: "Invitation to a Densio organization",
    text: instructions,
    html: `<!doctype html><html lang="en"><body><pre>${escapeHtml(instructions)}</pre></body></html>`,
  };
};
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
