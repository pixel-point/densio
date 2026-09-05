import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { resolveApiUrl } from "./config.ts";

export interface CliDependencies {
  readonly credentialsPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly writeStderr?: (text: string) => void;
  readonly writeStdout?: (text: string) => void;
}

export interface CliRuntime {
  readonly explicitOrganizationId?: string;
  readonly environmentOrganizationId?: string;
  readonly apiUrl: string;
  readonly credentialsPath: string;
  readonly fetch: typeof globalThis.fetch;
  readonly json: boolean;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

interface RuntimeArguments {
  readonly organizationId?: string;
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
    ...(argumentsInput.organizationId === undefined
      ? {}
      : { explicitOrganizationId: argumentsInput.organizationId }),
    ...(environment.DENSIO_ORG_ID === undefined
      ? {}
      : { environmentOrganizationId: environment.DENSIO_ORG_ID }),
    apiUrl: resolveApiUrl({
      ...(environment.DENSIO_API_URL === undefined
        ? {}
        : { environmentApiUrl: environment.DENSIO_API_URL }),
      ...(argumentsInput.apiUrl === undefined ? {} : { flagApiUrl: argumentsInput.apiUrl }),
    }),
    credentialsPath:
      argumentsInput.credentialsPath ??
      dependencies.credentialsPath ??
      environment.DENSIO_CREDENTIALS_PATH ??
      defaultCredentialsPath(environment),
    fetch: dependencies.fetch ?? globalThis.fetch,
    json: argumentsInput.json,
    now: dependencies.now ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((milliseconds, signal) => setTimeout(milliseconds, undefined, signal ? { signal } : {})),
    writeStderr: dependencies.writeStderr ?? ((text) => process.stderr.write(text)),
    writeStdout: dependencies.writeStdout ?? ((text) => process.stdout.write(text)),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  };
};

const defaultCredentialsPath = (environment: NodeJS.ProcessEnv) => {
  if (environment.XDG_CONFIG_HOME !== undefined) {
    return join(environment.XDG_CONFIG_HOME, "densio", "credentials.json");
  }
  if (process.platform === "win32" && environment.APPDATA !== undefined) {
    return join(environment.APPDATA, "densio", "credentials.json");
  }
  return join(homedir(), ".config", "densio", "credentials.json");
};
