import { Schema } from "effect";

import { IdentifierSchema, SchemaVersionSchema } from "./common-contracts.ts";

export const successEnvelope = <A extends Schema.Top>(data: A) =>
  Schema.Struct({
    ok: Schema.Literal(true),
    schemaVersion: SchemaVersionSchema,
    data,
    correlationId: IdentifierSchema,
  });

export type SuccessEnvelope<A> = {
  readonly ok: true;
  readonly schemaVersion: 1;
  readonly data: A;
  readonly correlationId: string;
};
