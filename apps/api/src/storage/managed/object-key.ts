import { FilenameStemSchema, MEDIA_CODEC_POLICY, type MediaCodec } from "@densio/shared";
import { Schema } from "effect";

const KeySegment = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/));
const Filename = Schema.String.check(
  Schema.isPattern(
    /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:vp9|av1)\.webm$|^[a-z0-9]+(?:-[a-z0-9]+)*-h265\.mp4$/,
  ),
);

export const filenameStem = (name: string | undefined, sourceFilename: string) =>
  (
    name ??
    sourceFilename
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.[^.]*$/, "") ??
    "video"
  )
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "") || "video";

export const variantFilename = (stem: string, codec: MediaCodec) =>
  `${Schema.decodeUnknownSync(FilenameStemSchema)(stem)}-${codec}.${MEDIA_CODEC_POLICY[codec].container}`;

export const managedObjectKey = (
  organizationId: string,
  videoId: string,
  filename: string,
  copyId?: string,
) => {
  const decode = Schema.decodeUnknownSync(KeySegment);
  return `orgs/${decode(organizationId)}/videos/${decode(videoId)}/${copyId === undefined ? "" : `copies/${decode(copyId)}/`}${Schema.decodeUnknownSync(Filename)(filename)}`;
};
