import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactTokenExpired,
  InvalidArtifactToken,
  artifactTokenLookupHash,
  createArtifactAccessToken,
  createArtifactEtag,
  ensureArtifactTokenActive,
  hashArtifactAccessToken,
  publishStagedArtifact,
} from "../src/storage/artifact.ts";
import {
  InvalidStoragePath,
  makeJobStoragePaths,
  prepareJobWorkspace,
} from "../src/storage/workspace.ts";

const temporaryRoots: Array<string> = [];

const makePaths = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-artifact-"));
  temporaryRoots.push(root);
  const paths = await Effect.runPromise(makeJobStoragePaths(root, "job-artifact"));
  await Effect.runPromise(prepareJobWorkspace(paths, { includeArtifactDirectory: true }));
  return paths;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("artifact publication", () => {
  it("atomically moves a complete staged file and returns streamed metadata", async () => {
    const paths = await makePaths();
    const stagedPath = join(paths.stagingDirectory, "encoded-video.partial");
    await writeFile(stagedPath, "published video");

    const published = await Effect.runPromise(
      publishStagedArtifact(paths, {
        artifactFilename: "encoded-video.webm",
        stagedFilename: "encoded-video.partial",
      }),
    );

    expect(published).toEqual({
      etag: '"sha256-fcb002072ca3de91ff5a8398aa4eb35384fb8405734a6b03f69f4a449c59efcf"',
      path: join(paths.artifactDirectory, "encoded-video.webm"),
      sha256: "fcb002072ca3de91ff5a8398aa4eb35384fb8405734a6b03f69f4a449c59efcf",
      sizeBytes: 15,
    });
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(published.path, "utf8")).resolves.toBe("published video");
  });

  it("rejects unsafe filenames without moving the staged output", async () => {
    const paths = await makePaths();
    const stagedPath = join(paths.stagingDirectory, "encoded-video.partial");
    await writeFile(stagedPath, "complete");

    const error = await Effect.runPromise(
      Effect.flip(
        publishStagedArtifact(paths, {
          artifactFilename: "../escaped.webm",
          stagedFilename: "encoded-video.partial",
        }),
      ),
    );

    expect(error).toBeInstanceOf(InvalidStoragePath);
    await expect(readFile(stagedPath, "utf8")).resolves.toBe("complete");
  });
});

describe("artifact access tokens", () => {
  it("creates unguessable tokens and exposes only a stable hash for lookup", async () => {
    const first = createArtifactAccessToken(2_000);
    const second = createArtifactAccessToken(2_000);

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.accessTokenHash).toBe(hashArtifactAccessToken(first.token));
    expect(first.accessTokenHash).toMatch(/^sha256\.[A-Za-z0-9_-]{43}$/);
    expect(first.accessTokenHash).not.toContain(first.token);
    await expect(Effect.runPromise(artifactTokenLookupHash(first.token))).resolves.toBe(
      first.accessTokenHash,
    );
  });

  it.each(["", "short", "not valid because spaces", 123, null])(
    "rejects malformed lookup token %j",
    async (token) => {
      const error = await Effect.runPromise(Effect.flip(artifactTokenLookupHash(token)));
      expect(error).toBeInstanceOf(InvalidArtifactToken);
    },
  );

  it("accepts a token before expiry and rejects it at the exact expiry instant", async () => {
    await expect(
      Effect.runPromise(ensureArtifactTokenActive(2_000, 1_999)),
    ).resolves.toBeUndefined();

    const error = await Effect.runPromise(Effect.flip(ensureArtifactTokenActive(2_000, 2_000)));
    expect(error).toBeInstanceOf(ArtifactTokenExpired);
  });
});

describe("artifact ETags", () => {
  it("creates a strong quoted ETag from the persisted SHA-256", () => {
    expect(createArtifactEtag("abc123")).toBe('"sha256-abc123"');
  });
});
