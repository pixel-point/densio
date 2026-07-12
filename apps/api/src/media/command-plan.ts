import { MediaPlanError } from "./media-plan-error.ts";

export interface CommandPlan {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly displayCommand: string;
}

const unquotedShellArgument = /^[a-zA-Z0-9_@%+=:,./-]+$/;

export const assertCommandPath = (path: string, label: string) => {
  if (typeof path !== "string" || path.length === 0 || hasForbiddenCommandText(path)) {
    throw new MediaPlanError("INVALID_COMMAND_PATH", `${label} path is invalid`);
  }
};

export const createCommandPlan = (executable: string, argv: readonly string[]): CommandPlan => {
  assertCommandPath(executable, "Executable");
  argv.forEach((argument) => {
    if (typeof argument !== "string" || hasForbiddenCommandText(argument)) {
      throw new MediaPlanError("INVALID_COMMAND_ARGUMENT", "Command argument is invalid");
    }
  });

  return {
    executable,
    argv,
    displayCommand: [executable, ...argv].map(quoteShellArgument).join(" "),
  };
};

const quoteShellArgument = (argument: string) => {
  if (unquotedShellArgument.test(argument)) return argument;

  return `'${argument.replaceAll("'", `'"'"'`)}'`;
};

const hasForbiddenCommandText = (value: string) =>
  value.includes("\0") || value.includes("\r") || value.includes("\n");
