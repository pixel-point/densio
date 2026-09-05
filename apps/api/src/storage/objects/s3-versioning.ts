export const supportsS3ObjectVersions = (endpoint: string) =>
  !new URL(endpoint).hostname.endsWith(".r2.cloudflarestorage.com");

// R2 returns object identities in x-amz-version-id but rejects versionId requests.
export const s3ObjectVersion = (supported: boolean, versionId: string | undefined) =>
  supported ? versionId : undefined;

export const s3VersionResult = (supported: boolean, versionId: string | undefined) =>
  supported && versionId !== undefined ? { versionId } : {};
