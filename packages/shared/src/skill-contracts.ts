import { Schema } from "effect";

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const SkillFilePathSchema = Schema.String.check(
  Schema.isPattern(/^(?:SKILL\.md|references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/),
);
export const SkillVersionSchema = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));

export const SkillFileSchema = Schema.Struct({
  content: Schema.NonEmptyString,
  path: SkillFilePathSchema,
  sha256: Sha256Schema,
});
export type SkillFile = typeof SkillFileSchema.Type;

export const SkillBundleSchema = Schema.Struct({
  entrypoint: Schema.Literal("SKILL.md"),
  files: Schema.Array(SkillFileSchema).check(Schema.isMinLength(1)),
  skillVersion: SkillVersionSchema,
}).check(
  Schema.makeFilter(({ entrypoint, files }) => {
    if (!files.some(({ path }) => path === entrypoint)) {
      return "Skill bundle files must include the declared entrypoint";
    }
    const paths = files.map(({ path }) => path);
    if (new Set(paths).size !== paths.length) return "Skill bundle file paths must be unique";
  }),
);
export type SkillBundle = typeof SkillBundleSchema.Type;

export const SkillSelectionSchema = Schema.Struct({
  cliVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)),
  entrypoint: Schema.Literal("SKILL.md"),
  files: Schema.Array(SkillFileSchema).check(Schema.isLengthBetween(1, 1)),
  references: Schema.Array(Schema.Struct({ path: SkillFilePathSchema, sha256: Sha256Schema })),
  skillVersion: SkillVersionSchema,
});
export type SkillSelection = typeof SkillSelectionSchema.Type;
