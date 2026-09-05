import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename } from "node:fs/promises";

import { Effect, Schema } from "effect";

import {
  type JobStoragePaths,
  StorageOperationError,
  resolveArtifactFile,
  resolveStagedFile,
} from "./workspace.ts";

const TOKEN_BYTES = 32;
const ArtifactTokenSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/, { expected: "a valid artifact token" }),
);
const decodeArtifactToken = Schema.decodeUnknownEffect(ArtifactTokenSchema);

export class InvalidArtifactToken extends Schema.TaggedErrorClass<InvalidArtifactToken>()(
  "InvalidArtifactToken",
  { message: Schema.String },
) {}

export class ArtifactTokenExpired extends Schema.TaggedErrorClass<ArtifactTokenExpired>()(
  "ArtifactTokenExpired",
  { message: Schema.String },
) {}

type PublishArtifactOptions = Readonly<{
  artifactFilename: unknown;
  stagedFilename: unknown;
}>;

export const createArtifactEtag = (sha256: string) => `"sha256-${sha256}"`;

export const hashArtifactAccessToken = (token: string) =>
  `sha256.${createHash("sha256").update(token).digest("base64url")}`;

export const createArtifactAccessToken = (expiresAt: number) => {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");

  return { accessTokenHash: hashArtifactAccessToken(token), expiresAt, token } as const;
};

export const artifactTokenLookupHash = Effect.fn("Artifact.tokenLookupHash")(function* (
  tokenInput: unknown,
) {
  const token = yield* decodeArtifactToken(tokenInput).pipe(
    Effect.mapError(
      () => new InvalidArtifactToken({ message: "The artifact access token is invalid." }),
    ),
  );

  return hashArtifactAccessToken(token);
});

export const ensureArtifactTokenActive = Effect.fn("Artifact.ensureTokenActive")(function* (
  expiresAt: number,
  now: number,
) {
  if (now >= expiresAt) {
    return yield* new ArtifactTokenExpired({ message: "The artifact access token has expired." });
  }
});

const readFileMetadata = async (path: string) => {
  const digest = createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of createReadStream(path)) {
    sizeBytes += chunk.length;
    digest.update(chunk);
  }

  const sha256 = digest.digest("hex");
  return { etag: createArtifactEtag(sha256), sha256, sizeBytes } as const;
};

const publicationOperation = <Value>(operation: string, run: () => Promise<Value>) =>
  Effect.tryPromise({
    catch: () => new StorageOperationError({ message: "Artifact publication failed.", operation }),
    try: run,
  }).pipe(Effect.uninterruptible);

export const publishStagedArtifact = Effect.fn("Storage.publishStagedArtifact")(function* (
  paths: JobStoragePaths,
  options: PublishArtifactOptions,
) {
  const stagedPath = yield* resolveStagedFile(paths, options.stagedFilename);
  const artifactPath = yield* resolveArtifactFile(paths, options.artifactFilename);
  const metadata = yield* publicationOperation("hash-staged-artifact", () =>
    readFileMetadata(stagedPath),
  );

  yield* publicationOperation("publish-staged-artifact", () => rename(stagedPath, artifactPath));

  return { ...metadata, path: artifactPath } as const;
});
