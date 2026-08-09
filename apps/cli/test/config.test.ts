import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearCredentials,
  readCredentials,
  resolveApiUrl,
  writeCredentials,
} from "../src/config.ts";
import { makeCliRuntime } from "../src/runtime.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CLI configuration", () => {
  it("uses only Densio environment variables and configuration paths", () => {
    const runtime = makeCliRuntime(
      { json: false },
      {
        environment: {
          DENSIO_CREDENTIALS_PATH: "/tmp/densio-credentials.json",
          DENSIO_API_URL: "https://densio.example",
        },
      },
    );

    expect(runtime.apiUrl).toBe("https://densio.example");
    expect(runtime.credentialsPath).toBe("/tmp/densio-credentials.json");

    const defaultRuntime = makeCliRuntime(
      { json: false },
      { environment: { XDG_CONFIG_HOME: "/tmp/config" } },
    );
    expect(defaultRuntime.credentialsPath).toBe("/tmp/config/densio/credentials.json");
  });

  it("uses flag, environment, file, and default API URL precedence", () => {
    expect(
      resolveApiUrl({
        configApiUrl: "https://file.example",
        environmentApiUrl: "https://env.example",
        flagApiUrl: "https://flag.example",
      }),
    ).toBe("https://flag.example");
    expect(
      resolveApiUrl({
        configApiUrl: "https://file.example",
        environmentApiUrl: "https://env.example",
      }),
    ).toBe("https://env.example");
    expect(resolveApiUrl({ configApiUrl: "https://file.example" })).toBe("https://file.example");
    expect(resolveApiUrl({})).toBe("http://localhost:3000");
  });

  it("writes and clears credentials with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "densio-cli-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "credentials.json");
    const credentials = {
      accessToken: "access",
      accessTokenExpiresAt: "2026-07-11T11:00:00.000Z",
      apiUrl: "https://api.example/v1/",
      refreshToken: "refresh",
    };

    await writeCredentials(path, credentials);

    expect(await readCredentials(path)).toEqual({
      ...credentials,
      apiUrl: "https://api.example",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await clearCredentials(path);
    await expect(readCredentials(path)).resolves.toBeUndefined();
  });
});
