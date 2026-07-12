import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const initializationVectorBytes = 12;
const authenticationTagBytes = 16;
const envelopeVersion = "v1";

export interface MagicLinkContext {
  readonly challengeId: string;
  readonly emailId: string;
  readonly recipient: string;
}

export type MagicLinkSealer = (url: string, context: MagicLinkContext) => string;
export type MagicLinkOpener = (sealed: string, context: MagicLinkContext) => string;

export class InvalidMagicLinkSecret extends Error {
  override readonly name = "InvalidMagicLinkSecret";

  constructor() {
    super("The encrypted magic-link payload is invalid.");
  }
}

export const makeMagicLinkSealer = (keyHex: string): MagicLinkSealer => {
  const key = decodeKey(keyHex);
  return (url, context) => {
    const initializationVector = randomBytes(initializationVectorBytes);
    const cipher = createCipheriv(algorithm, key, initializationVector);
    cipher.setAAD(associatedData(context));
    const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    return [
      envelopeVersion,
      initializationVector.toString("base64url"),
      authenticationTag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  };
};

export const makeMagicLinkOpener = (keyHex: string): MagicLinkOpener => {
  const key = decodeKey(keyHex);
  return (sealed, context) => {
    try {
      const { authenticationTag, ciphertext, initializationVector } = decodeEnvelope(sealed);
      const decipher = createDecipheriv(algorithm, key, initializationVector);
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new InvalidMagicLinkSecret();
    }
  };
};

const decodeKey = (keyHex: string) => {
  if (!/^[\dA-Fa-f]{64}$/u.test(keyHex)) throw new InvalidMagicLinkSecret();
  return Buffer.from(keyHex, "hex");
};

const decodeEnvelopePart = (value: string) => {
  if (!/^[\w-]+$/u.test(value)) throw new InvalidMagicLinkSecret();
  return Buffer.from(value, "base64url");
};

const decodeEnvelope = (sealed: string) => {
  const [version, encodedInitializationVector, encodedAuthenticationTag, encodedCiphertext] =
    sealed.split(".");
  if (
    version !== envelopeVersion ||
    encodedInitializationVector === undefined ||
    encodedAuthenticationTag === undefined ||
    encodedCiphertext === undefined ||
    sealed.split(".").length !== 4
  ) {
    throw new InvalidMagicLinkSecret();
  }
  const initializationVector = decodeEnvelopePart(encodedInitializationVector);
  const authenticationTag = decodeEnvelopePart(encodedAuthenticationTag);
  const ciphertext = decodeEnvelopePart(encodedCiphertext);
  if (
    initializationVector.length !== initializationVectorBytes ||
    authenticationTag.length !== authenticationTagBytes ||
    ciphertext.length === 0
  ) {
    throw new InvalidMagicLinkSecret();
  }
  return { authenticationTag, ciphertext, initializationVector };
};

const associatedData = ({ challengeId, emailId, recipient }: MagicLinkContext) =>
  Buffer.from(JSON.stringify([emailId, challengeId, recipient]), "utf8");
