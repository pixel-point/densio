import { Text } from "react-email";
import { EmailLayout } from "../components/email-layout.tsx";
import { emailStyles } from "../theme.ts";

export interface StorageRetentionEmailProps {
  readonly organizationName: string;
  readonly deadline: number;
}

export const StorageRetentionEmail = ({
  organizationName,
  deadline,
}: StorageRetentionEmailProps) => (
  <EmailLayout
    preview={`Free up storage or upgrade to keep ${organizationName}'s videos available.`}
    heading="Your video storage is over its limit"
    notice="You're receiving this notice because you're the billing contact for this Densio organization."
  >
    <Text style={emailStyles.paragraph}>
      {organizationName} is using more video storage than its current Densio plan includes.
    </Text>
    <Text style={emailStyles.paragraph}>
      To keep your videos available, upgrade your plan or delete videos you no longer need before{" "}
      {new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(deadline)}.
    </Text>
    <Text style={emailStyles.paragraph}>
      If you want to keep a copy outside Densio, export your videos to your own S3-compatible
      storage, then delete the copies hosted by Densio to free up space.
    </Text>
    <Text style={emailStyles.paragraph}>
      If storage usage is still over the limit at the deadline, Densio will permanently delete
      videos it hosts, starting with the most recently stored, until usage fits your plan. On the
      Free plan, this means deleting all videos hosted by Densio.
    </Text>
    <Text style={emailStyles.paragraph}>
      Links and embeds for deleted videos will stop working. Videos stored in your own storage are
      not affected.
    </Text>
  </EmailLayout>
);

StorageRetentionEmail.PreviewProps = {
  organizationName: "Example Studio",
  deadline: Date.UTC(2027, 0, 15, 8),
} satisfies StorageRetentionEmailProps;

export default StorageRetentionEmail;
