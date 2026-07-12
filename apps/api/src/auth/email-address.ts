import { Effect, Schema, SchemaTransformation } from "effect";

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const isValidEmailAddress = (email: string) => {
  const localPart = email.slice(0, email.indexOf("@"));

  return (
    email.length <= 254 &&
    localPart.length <= 64 &&
    !localPart.startsWith(".") &&
    !localPart.endsWith(".") &&
    !localPart.includes("..") &&
    EMAIL_PATTERN.test(email)
  );
};

const EmailAddressSchema = Schema.Trim.pipe(
  Schema.decode(SchemaTransformation.toLowerCase()),
  Schema.check(Schema.makeFilter(isValidEmailAddress, { expected: "a valid email address" })),
);

const decodeEmailAddress = Schema.decodeUnknownEffect(EmailAddressSchema);

export class InvalidEmailAddress extends Schema.TaggedErrorClass<InvalidEmailAddress>()(
  "InvalidEmailAddress",
  { message: Schema.String },
) {}

export const parseEmailAddress = Effect.fn("Auth.parseEmailAddress")((input: unknown) =>
  decodeEmailAddress(input).pipe(
    Effect.mapError(() => new InvalidEmailAddress({ message: "Enter a valid email address." })),
  ),
);
