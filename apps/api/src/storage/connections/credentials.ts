import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Schema } from "effect";

import { StorageCredentialsSchema } from "@densio/shared";
const CredentialPayloadSchema = Schema.Struct({
  ...StorageCredentialsSchema.fields,
  staging: Schema.optionalKey(StorageCredentialsSchema),
});
export type CredentialPayload = typeof CredentialPayloadSchema.Type;
export interface CredentialBinding {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly version: number;
}
const decodeKey = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
);

export const sealStorageCredentials = (
  key: string,
  binding: CredentialBinding,
  credentials: CredentialPayload,
) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(decodeKey(key), "hex"), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
};

export const openStorageCredentials = (
  key: string,
  binding: CredentialBinding,
  ciphertext: string,
) => {
  const bytes = Buffer.from(ciphertext, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(decodeKey(key), "hex"),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(JSON.stringify(binding)));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Schema.decodeUnknownSync(Schema.fromJsonString(CredentialPayloadSchema))(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
  );
};
