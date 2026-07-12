import { CliUsageError } from "./cli-errors.ts";

export interface GlobalArguments {
  readonly apiUrl?: string;
  readonly arguments: ReadonlyArray<string>;
  readonly credentialsPath?: string;
  readonly help: boolean;
  readonly json: boolean;
}

export const parseGlobalArguments = (argv: ReadonlyArray<string>): GlobalArguments => {
  const argumentsRemaining: Array<string> = [];
  let apiUrl: string | undefined;
  let credentialsPath: string | undefined;
  let help = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--api-url" || argument === "--credentials") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${argument} requires a value.`);
      }
      if (argument === "--api-url") apiUrl = value;
      if (argument === "--credentials") credentialsPath = value;
      index += 1;
      continue;
    }
    if (argument !== undefined) argumentsRemaining.push(argument);
  }

  return {
    arguments: argumentsRemaining,
    help,
    json,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
  };
};
