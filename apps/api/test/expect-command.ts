import { expect } from "vitest";

export const expectCommandSequence = (
  arguments_: readonly string[] | undefined,
  ...sequence: readonly string[]
) => {
  expect(arguments_).toBeDefined();
  expect(arguments_?.join("\0")).toContain(sequence.join("\0"));
};
