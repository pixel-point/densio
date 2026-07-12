import { homedir } from "node:os";
import { join } from "node:path";

import { resolveApiUrl } from "./config.ts";

export interface CliDependencies {
  readonly credentialsPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly writeStderr?: (text: string) => void;
  readonly writeStdout?: (text: string) => void;
}

export interface CliRuntime {
  readonly apiUrl: string;
  readonly credentialsPath: string;
  readonly fetch: typeof globalThis.fetch;
  readonly json: boolean;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

interface RuntimeArguments {
  readonly apiUrl?: string;
  readonly credentialsPath?: string;
  readonly json: boolean;
}

export const makeCliRuntime = (
  argumentsInput: RuntimeArguments,
  dependencies: CliDependencies,
): CliRuntime => {
  const environment = dependencies.environment ?? process.env;

  return {
    apiUrl: resolveApiUrl({
      ...(environment.FFMPEG_API_URL === undefined
        ? {}
        : { environmentApiUrl: environment.FFMPEG_API_URL }),
      ...(argumentsInput.apiUrl === undefined ? {} : { flagApiUrl: argumentsInput.apiUrl }),
    }),
    credentialsPath:
      argumentsInput.credentialsPath ??
      dependencies.credentialsPath ??
      environment.FFMPEG_API_CREDENTIALS_PATH ??
      defaultCredentialsPath(environment),
    fetch: dependencies.fetch ?? globalThis.fetch,
    json: argumentsInput.json,
    now: dependencies.now ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    writeStderr: dependencies.writeStderr ?? ((text) => process.stderr.write(text)),
    writeStdout: dependencies.writeStdout ?? ((text) => process.stdout.write(text)),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  };
};

const defaultCredentialsPath = (environment: NodeJS.ProcessEnv) => {
  if (environment.XDG_CONFIG_HOME !== undefined) {
    return join(environment.XDG_CONFIG_HOME, "ffmpeg-api", "credentials.json");
  }
  if (process.platform === "win32" && environment.APPDATA !== undefined) {
    return join(environment.APPDATA, "ffmpeg-api", "credentials.json");
  }
  return join(homedir(), ".config", "ffmpeg-api", "credentials.json");
};
