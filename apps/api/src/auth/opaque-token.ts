import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

import { Effect, Schema } from "effect";

const PUBLIC_ID_BYTES = 16;
const SECRET_BYTES = 32;
const HASH_PATTERN = /^sha256\.([A-Za-z0-9_-]{43})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{32,128}$/;
const EMPTY_DIGEST = Buffer.alloc(SECRET_BYTES);

const OpaqueTokenSchema = Schema.String.check(
  Schema.isPattern(TOKEN_PATTERN, { expected: "a valid opaque token" }),
);
const decodeOpaqueToken = Schema.decodeUnknownEffect(OpaqueTokenSchema);

export class InvalidOpaqueToken extends Schema.TaggedErrorClass<InvalidOpaqueToken>()(
  "InvalidOpaqueToken",
  { message: Schema.String },
) {}

export class ParsedOpaqueToken {
  readonly #secret: string;
  readonly publicId: string;

  constructor(publicId: string, secret: string) {
    this.publicId = publicId;
    this.#secret = secret;
  }

  get secret() {
    return this.#secret;
  }

  toJSON() {
    return { publicId: this.publicId, secret: "[REDACTED]" } as const;
  }

  toString() {
    return `${this.publicId}.[REDACTED]`;
  }

  [inspect.custom]() {
    return `ParsedOpaqueToken { publicId: '${this.publicId}', secret: '[REDACTED]' }`;
  }
}

export const createOpaqueToken = () =>
  new ParsedOpaqueToken(
    randomBytes(PUBLIC_ID_BYTES).toString("base64url"),
    randomBytes(SECRET_BYTES).toString("base64url"),
  );

export const formatOpaqueToken = (token: ParsedOpaqueToken) => `${token.publicId}.${token.secret}`;

export const hashTokenSecret = (secret: string) =>
  `sha256.${createHash("sha256").update(secret).digest("base64url")}`;

export const verifyTokenSecret = (secret: string, storedHash: string) => {
  const candidate = createHash("sha256").update(secret).digest();
  const match = HASH_PATTERN.exec(storedHash);
  const decoded = match?.[1] ? Buffer.from(match[1], "base64url") : EMPTY_DIGEST;
  const isValidHash = match !== null && decoded.length === SECRET_BYTES;

  // Malformed hashes still take the fixed-width comparison path.
  return timingSafeEqual(candidate, isValidHash ? decoded : EMPTY_DIGEST) && isValidHash;
};

export const parseOpaqueToken = Effect.fn("Auth.parseOpaqueToken")(function* (input: unknown) {
  const token = yield* decodeOpaqueToken(input).pipe(
    Effect.mapError(
      () =>
        new InvalidOpaqueToken({
          message: "The authentication token is invalid.",
        }),
    ),
  );
  const separator = token.indexOf(".");

  return new ParsedOpaqueToken(token.slice(0, separator), token.slice(separator + 1));
});
